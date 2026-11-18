// Client for /api/me (identity + admin flag) and the admin-only allowlist
// management endpoint (/api/allowlist). Same session-token pattern as sync.js.

import { supabase } from "./supabaseClient";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : "";
  return { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" };
}

// { authorized, email, isAdmin, anthropicKey }. Returns {} on any error.
export async function getMe() {
  try {
    const res = await fetch("/api/me", { headers: await authHeaders() });
    if (!res.ok) return {};
    return await res.json();
  } catch (e) { return {}; }
}

export async function listAllowed() {
  const res = await fetch("/api/allowlist", { headers: await authHeaders() });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw apiError(res, j);
  return j.emails || [];
}

export async function addAllowed(email, invite) {
  const res = await fetch("/api/allowlist", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ email: email, invite: !!invite }) });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw apiError(res, j);
  return j; // { ok, email, invited, inviteError }
}

export async function removeAllowed(email) {
  const res = await fetch("/api/allowlist", { method: "DELETE", headers: await authHeaders(), body: JSON.stringify({ email: email }) });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw apiError(res, j);
  return j;
}

// patch: { is_admin?, scheduled_sync? }
export async function setAllowedFlags(email, patch) {
  const res = await fetch("/api/allowlist", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify(Object.assign({ email: email }, patch)) });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw apiError(res, j);
  return j;
}

// Lockout recovery: remove every two-factor app of another account (lost phone).
export async function resetAllowedMfa(email) {
  const res = await fetch("/api/allowlist", { method: "PATCH", headers: await authHeaders(), body: JSON.stringify({ email: email, reset_mfa: true }) });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw apiError(res, j);
  return j; // { ok, removed }
}

// An Error carrying the API's `code` (e.g. "mfa_enroll_required": an admin
// without two-factor yet — the Admin tab shows a prompt instead).
function apiError(res, j) {
  const e = new Error(j.error || ("HTTP " + res.status));
  if (j.code) e.code = j.code;
  e.status = res.status;
  return e;
}
