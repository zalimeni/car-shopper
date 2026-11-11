// Client side of AI scoring + Anthropic key management.
//
// Runs in the browser under the user's Supabase session (same auth pattern as
// sync.js). The key itself is only ever sent to /api/anthropic-key, which
// validates and stores it encrypted server-side; the browser keeps no copy and
// learns only status (configured / valid / last4). Every AI request goes to
// /api/ai (one task per request), which decrypts the key server-side.

import { supabase } from "./supabaseClient";
import { DEMO, demoScoreSet, demoPriceRead, demoBaselineFor, demoSuggest, demoScorePrompt } from "./demoRuntime";

const CHUNK = 4; // listings per scoring request (/api/ai task "score"); bounds request time/size
const REQUEST_TIMEOUT_MS = 75000; // > server function budget, so a real hang surfaces

// Scoring model choices shown in the UI. Must stay in sync with the server-side
// allowlist (api/_scoring.js SCORE_MODELS); the server ignores anything else.
export var SCORE_MODEL_OPTIONS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 — balanced (recommended)" },
  { id: "claude-opus-5-5", label: "Opus 5.5 — most nuanced" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 — fastest / cheapest" },
];
export var DEFAULT_SCORE_MODEL = "claude-sonnet-5-5";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : "";
  return { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" };
}

// AI fair-price verdict for the Price Check tool, grounded in the observed comps.
export async function generatePriceAssessment(query, comps, stats, confidence) {
  if (DEMO) return demoPriceRead(query, comps, stats, confidence);
  const res = await fetch("/api/ai", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ task: "price", query: query, comps: comps || [], stats: stats || null, confidence: confidence || null }),
  });
  const j = await res.json().catch(function () { return {}; });
  if (res.status === 401 || (j && (j.error === "key_rejected" || j.error === "no_key" || j.error === "key_unreadable"))) {
    const e = new Error(j.message || j.error || "Not authorized"); e.code = j.error || "key_rejected"; throw e;
  }
  if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
  return j.assessment;
}

// AI-assisted price baseline for a profile, grounded in its real listings.
export async function generateBaseline(profile, listings, model) {
  if (DEMO) return demoBaselineFor(profile, listings);
  const res = await fetch("/api/ai", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ task: "baseline", profile: profile, listings: listings || [], model: model }),
  });
  const j = await res.json().catch(function () { return {}; });
  if (res.status === 401 || (j && (j.error === "key_rejected" || j.error === "no_key" || j.error === "key_unreadable"))) {
    const e = new Error(j.message || j.error || "Not authorized"); e.code = j.error || "key_rejected"; throw e;
  }
  if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
  return j.baseline;
}

// The profile wizard's AI step: must-haves / dealbreakers / years to avoid for a
// vehicle, given the explore call's market snapshot. Uses the user's own key.
export async function suggestProfile(profile, market) {
  if (DEMO) return demoSuggest(profile, market);
  const res = await fetch("/api/ai", {
    method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ task: "suggest", profile: profile, market: market || {} }),
  });
  const j = await res.json().catch(function () { return {}; });
  if (res.status === 401 || (j && (j.error === "key_rejected" || j.error === "no_key" || j.error === "key_unreadable"))) {
    const e = new Error(j.message || j.error || "Not authorized"); e.code = j.error || "key_rejected"; throw e;
  }
  if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
  return j.suggestion;
}

// Default scoring system prompt + per-criterion guidance, for the prompt editor.
export async function getScorePrompt() {
  if (DEMO) return demoScorePrompt();
  try {
    const res = await fetch("/api/ai?task=prompt", { method: "GET", headers: await authHeaders() });
    if (!res.ok) return { system: "", guidance: {} };
    return await res.json();
  } catch (e) { return { system: "", guidance: {} }; }
}

// ── Key management ──

export async function getKeyStatus() {
  // Demo: a pretend key, so scoring (simulated — demoScoreSet) can be tried.
  if (DEMO) return { configured: true, valid: true, last4: "DEMO", demo: true };
  try {
    const res = await fetch("/api/anthropic-key", { method: "GET", headers: await authHeaders() });
    if (!res.ok) return { configured: false, valid: false, last4: "" };
    return await res.json();
  } catch (e) {
    return { configured: false, valid: false, last4: "" };
  }
}

export async function saveKey(key) {
  const res = await fetch("/api/anthropic-key", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ key: key }) });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.error || ("Couldn't save key (HTTP " + res.status + ")"));
  return j; // { configured, valid, last4 }
}

export async function removeKey() {
  const res = await fetch("/api/anthropic-key", { method: "DELETE", headers: await authHeaders() });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.error || ("Couldn't remove key (HTTP " + res.status + ")"));
  return j; // { configured:false, valid:false, last4:"" }
}

// ── Scoring ──

const CONCURRENCY = 3; // chunks in flight at once (speed vs. Anthropic rate limits)

// Score a set of listing/candidate objects. `ctx` = { criteria, globalReqs,
// profileById, model }. Listings are grouped by profileId (so each Anthropic
// call gets the right buyer profile), chunked, and run a few chunks at a time.
//
// Results are delivered PROGRESSIVELY: opts.onPairs([{item, result}]) fires as
// each chunk returns, so successes persist immediately and a later failure can't
// discard them. A single chunk failing (HTTP error, or a timeout from the tab
// being backgrounded) is non-fatal — just those items come back {ok:false} and
// get re-scored on the next run. Only a key-level failure throws (with .code)
// so the caller can prompt for a fresh key. Returns all pairs when done.
export async function scoreSet(items, ctx, opts) {
  if (DEMO) return demoScoreSet(items, ctx, opts);
  opts = opts || {};
  const groups = {};
  items.forEach(function (it) {
    const pid = it.profileId || "_none";
    (groups[pid] = groups[pid] || []).push(it);
  });
  const chunks = [];
  Object.keys(groups).forEach(function (pid) {
    const group = groups[pid];
    const profile = ctx.profileById ? ctx.profileById[pid] : null;
    for (let i = 0; i < group.length; i += CHUNK) chunks.push({ items: group.slice(i, i + CHUNK), profile: profile });
  });

  const headers = await authHeaders();
  const total = items.length;
  let done = 0;
  let fatal = null;
  const allPairs = [];

  function failPairs(chunk, error) {
    return chunk.items.map(function (it) { return { item: it, result: { ok: false, error: error } }; });
  }

  async function runChunk(chunk) {
    if (fatal) return;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    let pairs;
    try {
      const res = await fetch("/api/ai", {
        method: "POST", headers: headers, signal: controller.signal,
        body: JSON.stringify({ task: "score", listings: chunk.items, criteria: ctx.criteria, profile: chunk.profile, globalReqs: ctx.globalReqs, model: ctx.model, system: ctx.system, homeBase: ctx.homeBase }),
      });
      const j = await res.json().catch(function () { return {}; });
      if (res.status === 401 || (j && (j.error === "key_rejected" || j.error === "no_key" || j.error === "key_unreadable"))) {
        const err = new Error(j.message || j.error || "Scoring isn't authorized");
        err.code = j.error || "key_rejected";
        fatal = err;
        return;
      }
      if (!res.ok) {
        pairs = failPairs(chunk, j.error || ("HTTP " + res.status));
      } else {
        const byIdx = {};
        (j.results || []).forEach(function (r) { byIdx[r.index] = r; });
        pairs = chunk.items.map(function (it, idx) { return { item: it, result: byIdx[idx] || { ok: false, error: "no result" } }; });
      }
    } catch (e) {
      pairs = failPairs(chunk, e && e.name === "AbortError" ? "timed out (tab may have been backgrounded)" : ((e && e.message) || "request failed"));
    } finally {
      clearTimeout(timer);
    }
    if (fatal) return;
    allPairs.push.apply(allPairs, pairs);
    if (opts.onPairs) opts.onPairs(pairs);
    done += chunk.items.length;
    if (opts.onProgress) opts.onProgress(done, total);
  }

  let next = 0;
  async function worker() { while (next < chunks.length && !fatal) { await runChunk(chunks[next++]); } }
  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, chunks.length); w++) workers.push(worker());
  await Promise.all(workers);
  if (fatal) throw fatal;
  return allPairs;
}
