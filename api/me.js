// Lightweight authorization check for the client. Returns the same allowlist
// verdict as the rest of the /api surface (env list OR DB allowlist), so the UI
// can show a friendly "not authorized" screen instead of an empty app.
//
//   200 { authorized: true, email }   — signed in and allowlisted
//   401 { authorized: false, error }  — not signed in / bad token
//   403 { authorized: false, error }  — signed in but not allowlisted

import { authorize } from "./_auth.js";

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) {
    res.status(auth.status).json({ authorized: false, error: auth.error });
    return;
  }
  res.status(200).json({ authorized: true, email: auth.user.email || "" });
}
