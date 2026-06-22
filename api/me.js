// Lightweight authorization check for the client. Returns the same allowlist
// verdict as the rest of the /api surface (env list OR DB allowlist), so the UI
// can show a friendly "not authorized" screen instead of an empty app. Also
// reports the user's Anthropic-key status so the UI can enable/disable AI
// scoring without a second round trip.
//
//   200 { authorized: true, email, anthropicKey: {configured, valid, last4} }
//   401 { authorized: false, error }  — not signed in / bad token
//   403 { authorized: false, error }  — signed in but not allowlisted

import { authorize, isAdmin } from "./_auth.js";
import { getKeyStatus } from "./_supabaseAdmin.js";

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) {
    res.status(auth.status).json({ authorized: false, error: auth.error });
    return;
  }
  let anthropicKey = { configured: false, valid: false, last4: "" };
  if (!auth.user.debug) {
    try { anthropicKey = await getKeyStatus(auth.user.id); } catch (e) { /* status defaults to "no key" */ }
  }
  res.status(200).json({ authorized: true, email: auth.user.email || "", anthropicKey: anthropicKey, isAdmin: isAdmin(auth.user.email) });
}
