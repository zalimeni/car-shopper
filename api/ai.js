// Every AI feature, using the caller's own Anthropic key. One function, so the
// app stays well under Vercel's per-deployment function limit.
//
//   GET  ?task=prompt   -> { system, guidance }   default scoring prompt (any authorized caller)
//   POST { task: "score", listings, criteria, profile, globalReqs, model?, system?, homeBase? }
//        -> { results: [{ index, vin, ok, scores?, rationales?, summary?, error? }] }
//   POST { task: "price", query, comps, stats, confidence }          -> { assessment }
//   POST { task: "baseline", profile, listings }                     -> { baseline }
//   POST { task: "suggest", profile, market }                        -> { suggestion }
//
// Key errors come back as { error: "no_key" | "key_unreadable" | "key_rejected",
// message } (400 / 400 / 401); a 401 from Anthropic also marks the stored key
// invalid, so the UI prompts for a fresh one. Plumbing: api/_ai.js. Prompts and
// schemas: api/_scoring.js (score, baseline), api/_pricecheck.js, api/_suggest.js.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { cryptoReady } from "./_crypto.js";
import { loadAnthropicKey, isAuthError, rejectKey, callText, safeParse, errMsg } from "./_ai.js";
import { resolveScoreModel, SCORE_SYSTEM, CRITERION_GUIDANCE, buildScoreSchema, buildUserPrompt, coerceResult, BASELINE_SYSTEM, buildBaselineSchema, buildBaselinePrompt } from "./_scoring.js";
import { PRICE_MODEL, PRICE_SYSTEM, buildPricePrompt } from "./_pricecheck.js";
import { SUGGEST_SYSTEM, buildSuggestSchema, buildSuggestPrompt, coerceSuggestion } from "./_suggest.js";

const MAX_LISTINGS = 12; // the client chunks; this bounds one scoring request's fan-out

// One-shot tasks use a fixed fast model rather than the user's scoring model:
// Sonnet 5.5 is capable enough for an estimate the user edits. It REJECTS
// thinking:{type:"disabled"} (400), so they send thinking:{type:"between_tools"}
// — its lowest setting, no up-front reasoning — which keeps each call well
// under the 60 s function limit.
const BASELINE_MODEL = "claude-sonnet-5-5";
const SUGGEST_MODEL = "claude-sonnet-5-5";

const TASKS = { score: score, price: price, baseline: baseline, suggest: suggest };

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }

  if (req.method === "GET") {
    const t = req.query && req.query.task;
    if (t !== "prompt") { res.status(400).json({ error: "Unknown task" }); return; }
    res.status(200).json({ system: SCORE_SYSTEM, guidance: CRITERION_GUIDANCE });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "Use GET or POST" }); return; }

  const body = typeof req.body === "string" ? (safeParse(req.body) || {}) : req.body || {};
  const run = Object.prototype.hasOwnProperty.call(TASKS, body.task) ? TASKS[body.task] : null;
  if (!run) { res.status(400).json({ error: "Unknown task" }); return; }

  if (!cryptoReady()) { res.status(500).json({ error: "Key encryption is not configured on the server" }); return; }

  await run(auth.user.id, body, res);
}

// Load the key (or answer with why not) -> an Anthropic client, or null.
async function clientFor(userId, res) {
  const k = await loadAnthropicKey(userId);
  if (!k.apiKey) { res.status(k.status).json(k.body); return null; }
  return new Anthropic({ apiKey: k.apiKey });
}

// ── score: one Anthropic call per listing, run concurrently for the batch, each
// constrained to a JSON schema built from the supplied criteria. Per-listing
// failures (refusal, malformed output) are reported in-band so one bad listing
// doesn't sink the batch; a 401 fails the whole request.
async function score(userId, body, res) {
  const listings = Array.isArray(body.listings) ? body.listings : [];
  const criteria = Array.isArray(body.criteria) ? body.criteria : [];
  if (!listings.length) { res.status(400).json({ error: "No listings to score" }); return; }
  if (!criteria.length) { res.status(400).json({ error: "No criteria provided" }); return; }
  if (listings.length > MAX_LISTINGS) { res.status(400).json({ error: "Too many listings in one request (max " + MAX_LISTINGS + ")" }); return; }

  const client = await clientFor(userId, res);
  if (!client) return;
  const schema = buildScoreSchema(criteria);
  const model = resolveScoreModel(body.model); // UI choice, allowlisted; falls back to default
  const system = (typeof body.system === "string" && body.system.trim()) ? body.system.trim() : SCORE_SYSTEM;
  const ctx = { criteria: criteria, profile: body.profile, globalReqs: body.globalReqs, homeBase: body.homeBase };

  let authFailed = false;
  const results = await Promise.all(listings.map(async function (listing, index) {
    const vin = listing.vin || "";
    try {
      // Generous cap: Claude 5-family models always think, spending output
      // tokens before the JSON is emitted — a tight cap truncates.
      const r = await callText(client, {
        model: model,
        max_tokens: 8000,
        system: system,
        messages: [{ role: "user", content: buildUserPrompt(listing, ctx) }],
        output_config: { format: { type: "json_schema", schema: schema } },
      });
      if (r.fail) return { index: index, vin: vin, ok: false, error: r.fail === "truncated" ? "Model output hit the token limit" : "Model declined this listing" };
      const coerced = coerceResult(safeParse(r.text), criteria);
      if (!coerced) return { index: index, vin: vin, ok: false, error: "Model output missing required criteria" };
      return Object.assign({ index: index, vin: vin, ok: true }, coerced);
    } catch (e) {
      if (isAuthError(e)) authFailed = true;
      return { index: index, vin: vin, ok: false, error: errMsg(e, "Scoring failed") };
    }
  }));

  if (authFailed) { await rejectKey(userId, res); return; }
  res.status(200).json({ results: results });
}

// ── price: a plain-English fair-price verdict for the Price Check tool.
async function price(userId, body, res) {
  const q = body.query || {};
  if (!q.make && !q.model) { res.status(400).json({ error: "Need at least a make and model" }); return; }
  const client = await clientFor(userId, res);
  if (!client) return;
  await oneShot(userId, res, "Assessment failed", async function () {
    const r = await callText(client, {
      model: PRICE_MODEL,
      max_tokens: 1024,
      thinking: { type: "between_tools" },
      system: PRICE_SYSTEM,
      messages: [{ role: "user", content: buildPricePrompt(q, Array.isArray(body.comps) ? body.comps : [], body.stats || null, body.confidence || null) }],
    }, { allowTruncated: true });
    if (r.fail) return { status: 502, body: { error: "The model declined this request" } };
    const text = r.text.trim();
    if (!text) return { status: 502, body: { error: "Empty response from the model" } };
    return { body: { assessment: text } };
  });
}

// ── baseline: price tiers for a profile, grounded in its real synced listings.
async function baseline(userId, body, res) {
  const profile = body.profile || {};
  if (!profile.params || !profile.params.make || !profile.params.model) { res.status(400).json({ error: "Profile needs a make and model" }); return; }
  const client = await clientFor(userId, res);
  if (!client) return;
  const listings = Array.isArray(body.listings) ? body.listings : [];
  await oneShot(userId, res, "Baseline generation failed", async function () {
    const r = await callText(client, {
      model: BASELINE_MODEL,
      max_tokens: 8000,
      thinking: { type: "between_tools" },
      system: BASELINE_SYSTEM,
      messages: [{ role: "user", content: buildBaselinePrompt(profile, listings) }],
      output_config: { format: { type: "json_schema", schema: buildBaselineSchema() } },
    });
    if (r.fail) return failBody(r.fail);
    const parsed = safeParse(r.text);
    if (!parsed || !Array.isArray(parsed.tiers)) return { status: 502, body: { error: "Couldn't parse the generated baseline" } };
    return { body: { baseline: parsed } };
  });
}

// ── suggest: the profile wizard's must-haves / dealbreakers / years to avoid.
async function suggest(userId, body, res) {
  const profile = body.profile || {};
  if (!profile.params || !profile.params.make || !profile.params.model) { res.status(400).json({ error: "Profile needs a make and model" }); return; }
  const client = await clientFor(userId, res);
  if (!client) return;
  await oneShot(userId, res, "Suggestion failed", async function () {
    const r = await callText(client, {
      model: SUGGEST_MODEL,
      max_tokens: 4000,
      thinking: { type: "between_tools" },
      system: SUGGEST_SYSTEM,
      messages: [{ role: "user", content: buildSuggestPrompt(profile, body.market) }],
      output_config: { format: { type: "json_schema", schema: buildSuggestSchema() } },
    });
    if (r.fail) return failBody(r.fail);
    const parsed = safeParse(r.text);
    if (!parsed) return { status: 502, body: { error: "Couldn't parse the suggestions" } };
    return { body: { suggestion: coerceSuggestion(parsed) } };
  });
}

function failBody(fail) {
  return { status: 502, body: { error: fail === "truncated" ? "Model output hit the token limit — try again" : "The model declined this request" } };
}

// Run a one-shot task and send its { status?, body }, turning a rejected key
// into the key_rejected answer and any other error into a 502.
async function oneShot(userId, res, fallback, fn) {
  try {
    const out = await fn();
    res.status(out.status || 200).json(out.body);
  } catch (e) {
    if (isAuthError(e)) { await rejectKey(userId, res); return; }
    res.status(502).json({ error: errMsg(e, fallback) });
  }
}
