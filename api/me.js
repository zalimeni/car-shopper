// Lightweight authorization check for the client. Returns the same allowlist
// verdict as the rest of the /api surface (public.allowed_emails), so the UI
// can show a friendly "not authorized" screen instead of an empty app. Also
// reports the user's key status (Anthropic: configured/valid/last4; MarketCheck:
// [{ id, label, last4 }]) so the UI can set itself up without a second round
// trip. Never returns a key itself.
//
//   200 { authorized: true, email, isAdmin, anthropicKey, marketcheckKeys }
//   401 { authorized: false, error }  — not signed in / bad token
//   403 { authorized: false, error }  — signed in but not allowlisted

import { authorize } from "./_auth.js";
import { keyMeta } from "./_keys.js";

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) {
    res.status(auth.status).json({ authorized: false, error: auth.error });
    return;
  }
  const meta = await keyMeta(auth.user.id);
  res.status(200).json({ authorized: true, email: auth.user.email || "", isAdmin: auth.admin, anthropicKey: meta.anthropic, marketcheckKeys: meta.marketcheck });
}
