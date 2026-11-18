// Two-factor auth (TOTP, Supabase Auth MFA): the client side.
//
// Sign-in is by email, which gives an aal1 session. Once an account has a
// verified authenticator app, everything — the /api functions (api/_auth.js)
// and app_state's RLS (public.mfa_ok()) — wants aal2, so after any email
// sign-in AuthGate (src/Auth.jsx) asks for a code first. Settings → Two-factor
// (MfaCard in App.jsx) enrolls and removes apps. Admins must enroll to use the
// Admin tab. TOTP only (phone MFA is a paid add-on), and Supabase has no
// recovery codes, so a second app is the backup; an admin can reset a locked-
// out account from the Admin tab.
//
// assurance()/needsStepUp()/qrSrc() are pure (tested). The rest wrap
// supabase.auth.mfa.* and are never called in demo mode (the UI is hidden).

import { supabase } from "./supabaseClient";

// Error codes from the API (api/_auth.js).
export var MFA_REQUIRED = "mfa_required"; // 401: enrolled, token is aal1
export var MFA_ENROLL_REQUIRED = "mfa_enroll_required"; // 403: admin endpoint, not aal2

function jwtPayload(token) {
  try {
    var part = String(token || "").split(".")[1];
    if (!part) return {};
    var b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) { return {}; }
}

// Like supabase.auth.mfa.getAuthenticatorAssuranceLevel(), but from a session
// already in hand: no getSession() (which can stall right after a sign-in —
// see AuthGate) and no network. currentLevel is the token's aal; nextLevel is
// aal2 when the session's user has a verified factor.
export function assurance(session) {
  if (!session) return { currentLevel: null, nextLevel: null };
  var p = jwtPayload(session.access_token);
  var current = p.aal === "aal2" ? "aal2" : "aal1";
  var factors = (session.user && session.user.factors) || [];
  var enrolled = factors.some(function (f) { return f.status === "verified"; });
  return { currentLevel: current, nextLevel: enrolled ? "aal2" : current };
}

export function needsStepUp(session) {
  var a = assurance(session);
  return a.nextLevel === "aal2" && a.currentLevel === "aal1";
}

export function isAal2(session) { return assurance(session).currentLevel === "aal2"; }

// supabase-js hands back the QR code as "data:image/svg+xml;utf-8,<svg …>"
// with the SVG unescaped; encode it so any "#" or quote in it can't cut the URL.
export function qrSrc(qr) {
  var s = String(qr || "");
  var m = /^data:image\/svg\+xml;utf-8,/.exec(s);
  if (m) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.slice(m[0].length));
  if (/^\s*<svg/i.test(s)) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  return s;
}

// The secret in groups of four, easier to type into an authenticator by hand.
export function groupSecret(secret) {
  return String(secret || "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

// { verified: [...], pending: [...] } TOTP factors (fresh from the Auth server).
export async function listTotp() {
  var r = await supabase.auth.mfa.listFactors();
  if (r.error) throw r.error;
  var all = (r.data && r.data.all) || [];
  var totp = all.filter(function (f) { return f.factor_type === "totp"; });
  return {
    verified: totp.filter(function (f) { return f.status === "verified"; }),
    pending: totp.filter(function (f) { return f.status !== "verified"; }),
  };
}

// Starts enrolling an authenticator app: { id, qr, secret, uri }. Drops any
// enrollment left unfinished first (their names would collide).
export async function startEnroll(name) {
  var cur = await listTotp();
  for (var i = 0; i < cur.pending.length; i++) await supabase.auth.mfa.unenroll({ factorId: cur.pending[i].id });
  var label = String(name || "").trim() || "Authenticator " + (cur.verified.length + 1);
  var r = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: label, issuer: "Car Shopper" });
  if (r.error) throw r.error;
  var t = r.data.totp || {};
  return { id: r.data.id, name: label, qr: qrSrc(t.qr_code), secret: t.secret || "", uri: t.uri || "" };
}

// Verifies the first code. On success the session is upgraded to aal2.
export async function confirmEnroll(factorId, code) {
  var r = await supabase.auth.mfa.challengeAndVerify({ factorId: factorId, code: String(code || "").trim() });
  if (r.error) throw r.error;
  return r.data;
}

export async function cancelEnroll(factorId) {
  try { await supabase.auth.mfa.unenroll({ factorId: factorId }); } catch (e) { /* left unverified; cleaned up next time */ }
}

// Needs an aal2 session (Supabase's rule).
export async function removeFactor(factorId) {
  var r = await supabase.auth.mfa.unenroll({ factorId: factorId });
  if (r.error) throw r.error;
}

function badCode(err) {
  var code = String((err && (err.code || err.error_code)) || "");
  return code === "mfa_verification_failed" || /invalid.*(code|totp)|verification failed/i.test(String((err && err.message) || ""));
}

// Step-up at sign-in: a code from any of the account's apps. Tries each
// verified factor until one accepts it (a code only matches its own app).
export async function verifyStepUp(code) {
  var list = await listTotp();
  if (!list.verified.length) throw new Error("No authenticator app is set up for this account");
  var last = null;
  for (var i = 0; i < list.verified.length; i++) {
    var r = await supabase.auth.mfa.challengeAndVerify({ factorId: list.verified[i].id, code: String(code || "").trim() });
    if (!r.error) return r.data;
    last = r.error;
    if (!badCode(r.error)) break;
  }
  throw last;
}

export function friendlyMfaError(err) {
  if (badCode(err)) return "That code didn't match. Check the time on your phone and enter the newest code.";
  var msg = String((err && err.message) || err || "");
  if (/aal2|assurance/i.test(msg)) return "Enter a two-factor code first (sign out and back in), then try again.";
  return msg || "Something went wrong";
}
