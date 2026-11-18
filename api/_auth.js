// Shared server-side auth gate for the /api functions.
//
// Files prefixed with "_" are treated as modules, not routes, by Vercel.
//
// Verifies the caller's Supabase access token (sent as `Authorization: Bearer`)
// and checks the account against the allowlist, public.allowed_emails (the one
// source of truth — RLS on app_state reads the same table through
// is_allowed()). Sign-up is invite-only (the project has sign-ups turned off
// and the app never creates users), so only invited people have accounts; the
// allowlist still decides who may use the API, and also who is an admin.
// Enforced here, server-side; the client cannot bypass it.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./_supabaseAdmin.js";

// Constant-time string compare (avoids leaking a secret via timing).
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Verifies access tokens. Kept across warm invocations so the project's
// signing keys (JWKS) are fetched once, not on every request: the project
// signs tokens with an asymmetric key, so getClaims() checks the signature
// and expiry locally instead of asking the Auth server (getUser()). Trade-off:
// a token signed out elsewhere still verifies until it expires (about an
// hour); the allowlist check below runs on every request regardless.
let verifier = null;
function claimsClient() {
  if (!verifier) {
    verifier = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return verifier;
}

// Codes for the client (src/Auth.jsx, src/App.jsx), sent as `code` beside
// `error` (see deny()):
//   mfa_required        401 — the account has a verified TOTP factor and this
//                       token is aal1 (email sign-in only): step up with a code.
//   mfa_enroll_required 403 — an admin-only endpoint, and the admin's session
//                       isn't aal2 because they haven't set up two-factor yet.
export const MFA_REQUIRED = "mfa_required";
export const MFA_ENROLL_REQUIRED = "mfa_enroll_required";

// Returns { user: { id, email }, admin, mfa: { enrolled, aal } } when the
// caller is authenticated AND allowlisted, otherwise { error, status, code? }
// (401 unauthenticated or MFA step-up needed, 403 not on the list).
//
// MFA: `aal` comes from the verified claims; whether the user has a verified
// factor comes from the same one RPC (my_access_mfa()). An enrolled user's
// aal1 token is refused everywhere — the rule RLS applies to app_state too
// (public.mfa_ok()). Users with no factor are unaffected.
export async function authorize(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = header.indexOf("Bearer ") === 0 ? header.slice(7).trim() : "";
  if (!token) return { error: "Missing authentication token", status: 401 };

  let claims = null;
  try {
    const { data, error } = await claimsClient().auth.getClaims(token);
    if (!error && data) claims = data.claims;
  } catch (e) { /* malformed token */ }
  if (!claims || !claims.sub || claims.role !== "authenticated" || claims.is_anonymous === true) {
    return { error: "Invalid or expired session", status: 401 };
  }

  // The RPC runs as the caller: PostgREST checks the same token again and
  // my_access_mfa() reads the email and user id from it.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } },
  });

  // One call answers all three: on the allowlist? an admin? enrolled in MFA?
  let access = null;
  try {
    let rpc = await supabase.rpc("my_access_mfa");
    // Rollout: the deploy can land a moment before the migration that adds
    // my_access_mfa() (PGRST202 = no such function). Answer from my_access()
    // until it exists; nobody can have enrolled before this code shipped.
    if (rpc.error && rpc.error.code === "PGRST202") rpc = await supabase.rpc("my_access");
    if (!rpc.error) access = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  } catch (e) { /* unreachable — treated as not allowed */ }

  if (!access || !access.allowed) return { error: "This account is not authorized to use this app", status: 403 };
  const aal = claims.aal === "aal2" ? "aal2" : "aal1";
  if (access.has_mfa && aal !== "aal2") {
    return { error: "Enter the code from your authenticator app to continue", status: 401, code: MFA_REQUIRED };
  }
  return { user: { id: claims.sub, email: claims.email || "" }, admin: !!access.admin, mfa: { enrolled: !!access.has_mfa, aal: aal } };
}

// Admin-only endpoints need an admin with an aal2 session: admins must use
// two-factor (owner's decision), so an admin who hasn't enrolled gets
// mfa_enroll_required until they do. Returns null when allowed, otherwise a
// failure for deny().
export function requireAdmin(auth) {
  if (!auth.admin) return { error: "Admins only", status: 403 };
  if (!auth.mfa || auth.mfa.aal !== "aal2") {
    return { error: "Set up two-factor authentication in Settings to use the Admin tab", status: 403, code: MFA_ENROLL_REQUIRED };
  }
  return null;
}

// Sends an authorize() / requireAdmin() failure as { error, code? }, plus any
// `extra` fields (e.g. /api/me's authorized: false).
export function deny(res, fail, extra) {
  const body = Object.assign({}, extra || {}, { error: fail.error });
  if (fail.code) body.code = fail.code;
  res.status(fail.status).json(body);
}
