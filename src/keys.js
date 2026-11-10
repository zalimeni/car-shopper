// Client for the user's MarketCheck keys in the server-side vault (/api/keys).
//
// The browser never holds a key after it's submitted: it sees metadata only —
// [{ id, label, last4, position, valid }] in the order the keys are used. The
// server reads the keys itself for every sync (api/_keys.js). Each call answers
// with the updated list. Same session-token pattern as score.js / admin.js.

import { supabase } from "./supabaseClient";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : "";
  return { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" };
}

async function call(method, body) {
  const res = await fetch("/api/keys", { method: method, headers: await authHeaders(), body: body ? JSON.stringify(Object.assign({ provider: "marketcheck" }, body)) : undefined });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.error || ("Couldn't update MarketCheck keys (HTTP " + res.status + ")"));
  return Array.isArray(j.marketcheck) ? j.marketcheck : [];
}

// The list, or null when it couldn't be read (offline, local dev without the
// functions) — so callers can tell "no keys" from "unknown".
export async function listMarketcheckKeys() {
  try { return await call("GET"); } catch (e) { return null; }
}
export function addMarketcheckKey(key, label) { return call("POST", { key: key, label: label || "" }); }
export function importMarketcheckKeys(entries) { return call("POST", { import: entries }); }
export function renameMarketcheckKey(id, label) { return call("PATCH", { id: id, label: label }); }
export function reorderMarketcheckKeys(ids) { return call("PATCH", { order: ids }); }
export function removeMarketcheckKey(id) { return call("DELETE", { id: id }); }

export { legacyBlobKeys } from "./quota.js";
