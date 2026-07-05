// Client side of AI scoring + Anthropic key management.
//
// Runs in the browser under the user's Supabase session (same auth pattern as
// sync.js). The key itself is only ever sent to /api/anthropic-key, which
// validates and stores it encrypted server-side; the browser keeps no copy and
// learns only status (configured / valid / last4). Scoring requests go to
// /api/score, which decrypts the key server-side to call Anthropic.

import { supabase } from "./supabaseClient";

const CHUNK = 4; // listings per /api/score request; bounds request time/size
const REQUEST_TIMEOUT_MS = 75000; // > server function budget, so a real hang surfaces

// Scoring model choices shown in the UI. Must stay in sync with the server-side
// allowlist (api/_scoring.js SCORE_MODELS); the server ignores anything else.
export var SCORE_MODEL_OPTIONS = [
  { id: "claude-sonnet-4-6", label: "Sonnet — balanced (recommended)" },
  { id: "claude-opus-4-8", label: "Opus — most nuanced" },
  { id: "claude-haiku-4-5", label: "Haiku — fastest / cheapest" },
];
export var DEFAULT_SCORE_MODEL = "claude-sonnet-4-6";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : "";
  return { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" };
}

// ── Key management ──

export async function getKeyStatus() {
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
      const res = await fetch("/api/score", {
        method: "POST", headers: headers, signal: controller.signal,
        body: JSON.stringify({ listings: chunk.items, criteria: ctx.criteria, profile: chunk.profile, globalReqs: ctx.globalReqs, model: ctx.model }),
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
