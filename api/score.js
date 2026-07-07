// AI scoring for listings, using the caller's own Anthropic key.
//
// Request:  POST { listings: [<listing>], criteria: [...], profile: {...},
//                  globalReqs: [...] }
// Response: { results: [{ index, vin, ok, scores?, rationales?, summary?,
//                         error? }] }
//
// One Anthropic call per listing (run concurrently for the batch), each
// constrained to a JSON schema built from the supplied criteria. The client
// chunks large sets; this endpoint scores whatever it's given. Per-listing
// failures (refusal, malformed output) are reported in-band so one bad listing
// doesn't sink the batch. A 401 from Anthropic flips the stored key to invalid
// and fails the whole request, so the UI can prompt for a fresh key.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { decrypt, cryptoReady } from "./_crypto.js";
import { getKeyRow, setKeyValid } from "./_supabaseAdmin.js";
import { resolveScoreModel, SCORE_SYSTEM, CRITERION_GUIDANCE, buildScoreSchema, buildUserPrompt, coerceResult } from "./_scoring.js";

const MAX_LISTINGS = 12; // client chunks; this bounds a single request's fan-out

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }

  // Expose the default prompt + per-criterion guidance so the UI can show/reset
  // them (any authorized user, incl. the debug bypass).
  if (req.method === "GET") {
    res.status(200).json({ system: SCORE_SYSTEM, guidance: CRITERION_GUIDANCE });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "Use GET or POST" }); return; }

  if (auth.user.debug) { res.status(400).json({ error: "AI scoring requires a real signed-in account" }); return; }
  if (!cryptoReady()) { res.status(500).json({ error: "Key encryption is not configured on the server" }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const listings = Array.isArray(body.listings) ? body.listings : [];
  const criteria = Array.isArray(body.criteria) ? body.criteria : [];
  if (!listings.length) { res.status(400).json({ error: "No listings to score" }); return; }
  if (!criteria.length) { res.status(400).json({ error: "No criteria provided" }); return; }
  if (listings.length > MAX_LISTINGS) {
    res.status(400).json({ error: "Too many listings in one request (max " + MAX_LISTINGS + ")" });
    return;
  }

  // Decrypt the caller's key from the server-only vault.
  const row = await getKeyRow(auth.user.id);
  if (!row) { res.status(400).json({ error: "no_key", message: "No Anthropic key on file — add one to enable scoring" }); return; }
  let apiKey;
  try { apiKey = decrypt(row.ciphertext); }
  catch (e) {
    await setKeyValid(auth.user.id, false);
    res.status(400).json({ error: "key_unreadable", message: "Stored key couldn't be decrypted — re-enter it" });
    return;
  }

  const client = new Anthropic({ apiKey: apiKey });
  const schema = buildScoreSchema(criteria);
  const model = resolveScoreModel(body.model); // UI choice, allowlisted; falls back to default
  const system = (typeof body.system === "string" && body.system.trim()) ? body.system.trim() : SCORE_SYSTEM;
  const ctx = { criteria: criteria, profile: body.profile, globalReqs: body.globalReqs };

  let authFailed = false;
  const results = await Promise.all(listings.map(async function (listing, index) {
    try {
      const r = await scoreOne(client, model, system, listing, ctx, schema);
      if (r.fail) return { index: index, vin: listing.vin || "", ok: false, error: r.fail === "truncated" ? "Model output hit the token limit" : "Model declined this listing" };
      const coerced = coerceResult(r.parsed, criteria);
      if (!coerced) return { index: index, vin: listing.vin || "", ok: false, error: "Model output missing required criteria" };
      return Object.assign({ index: index, vin: listing.vin || "", ok: true }, coerced);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || (e && e.status === 401)) { authFailed = true; }
      return { index: index, vin: listing.vin || "", ok: false, error: errMsg(e) };
    }
  }));

  if (authFailed) {
    await setKeyValid(auth.user.id, false);
    res.status(401).json({ error: "key_rejected", message: "Anthropic rejected your key — re-enter it" });
    return;
  }

  res.status(200).json({ results: results });
}

async function scoreOne(client, model, system, listing, ctx, schema) {
  // Generous cap: Claude 5-family models (e.g. the Sonnet 5 default) always
  // think, spending output tokens before the JSON is emitted — a tight cap
  // truncates to stop_reason:"max_tokens". Streamed so a long/slow response
  // can't trip an HTTP read timeout; .finalMessage() assembles the full Message.
  const resp = await client.messages.stream({
    model: model,
    max_tokens: 8000,
    system: system,
    messages: [{ role: "user", content: buildUserPrompt(listing, ctx) }],
    output_config: { format: { type: "json_schema", schema: schema } },
  }).finalMessage();
  if (resp.stop_reason === "refusal") return { fail: "refused" };
  if (resp.stop_reason === "max_tokens") return { fail: "truncated" };
  // With output_config.format the JSON lands in the (single) text block.
  const text = (resp.content || [])
    .filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; })
    .join("");
  return { parsed: safeParse(text) };
}

function errMsg(e) {
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit — try again shortly";
  if (e && e.message) return String(e.message).slice(0, 200);
  return "Scoring failed";
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
