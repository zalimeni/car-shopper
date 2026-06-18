// Client side of AI scoring + Anthropic key management.
//
// Runs in the browser under the user's Supabase session (same auth pattern as
// sync.js). The key itself is only ever sent to /api/anthropic-key, which
// validates and stores it encrypted server-side; the browser keeps no copy and
// learns only status (configured / valid / last4). Scoring requests go to
// /api/score, which decrypts the key server-side to call Anthropic.

import { supabase } from "./supabaseClient";

const CHUNK = 6; // listings per /api/score request; bounds request time/size

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

// Score a set of listing/candidate objects. `ctx` = { criteria, globalReqs,
// profileById }. Listings are grouped by profileId so each Anthropic call gets
// the right buyer profile, then chunked. Returns [{ item, result }] aligned to
// the input array — result is { ok, scores, rationales, summary } or
// { ok:false, error }. Throws (with .code) on key-level failures so the caller
// can prompt for a fresh key.
export async function scoreSet(items, ctx, onProgress) {
  const groups = {};
  items.forEach(function (it) {
    const pid = it.profileId || "_none";
    (groups[pid] = groups[pid] || []).push(it);
  });

  const resultByItem = new Map();
  let done = 0;

  const headers = await authHeaders();
  for (const pid of Object.keys(groups)) {
    const group = groups[pid];
    const profile = ctx.profileById ? ctx.profileById[pid] : null;
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK);
      const res = await fetch("/api/score", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ listings: chunk, criteria: ctx.criteria, profile: profile, globalReqs: ctx.globalReqs, model: ctx.model }),
      });
      const j = await res.json().catch(function () { return {}; });
      if (res.status === 401 || (j && (j.error === "key_rejected" || j.error === "no_key" || j.error === "key_unreadable"))) {
        const err = new Error(j.message || j.error || "Scoring isn't authorized");
        err.code = j.error || "key_rejected";
        throw err;
      }
      if (!res.ok) throw new Error(j.error || ("Scoring failed (HTTP " + res.status + ")"));
      (j.results || []).forEach(function (r) {
        const item = chunk[r.index];
        if (item) resultByItem.set(item, r);
      });
      done += chunk.length;
      if (onProgress) onProgress(done, items.length);
    }
  }

  return items.map(function (it) {
    return { item: it, result: resultByItem.get(it) || { ok: false, error: "no result returned" } };
  });
}
