// Admin-only management of the email allowlist (public.allowed_emails).
//
//   GET            — list { email, added_at } (admins only)
//   POST   { email, invite? } — add to the allowlist; optionally send a Supabase
//                    invite email (auth.admin.inviteUserByEmail)
//   DELETE { email } — remove from the allowlist
//
// The table is RLS-locked with no client policies, so this reaches it via the
// service-role client (SUPABASE_SECRET_KEY). Gated to admins (ADMIN_EMAILS env,
// default owner) — a non-admin authenticated user gets 403.

import { authorize, isAdmin } from "./_auth.js";
import { adminClient, anonClient } from "./_supabaseAdmin.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  if (auth.user.debug || !isAdmin(auth.user.email)) { res.status(403).json({ error: "Admins only" }); return; }

  const db = adminClient();
  if (!db) { res.status(500).json({ error: "Supabase secret key is not configured on the server" }); return; }

  if (req.method === "GET") {
    const { data, error } = await db.from("allowed_emails").select("email,added_at").order("added_at", { ascending: true });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ emails: data || [] });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const email = String(body.email || "").trim().toLowerCase();

  if (req.method === "POST") {
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: "Enter a valid email address" }); return; }
    const { error } = await db.from("allowed_emails").upsert({ email: email });
    if (error) { res.status(500).json({ error: error.message }); return; }

    // The allowlist row is written regardless — the person is approved now.
    // Invite is best-effort and reported separately.
    let invite = null;
    if (body.invite) invite = await doInvite(db, email, siteUrl(req));
    res.status(200).json({ ok: true, email: email, invite: invite });
    return;
  }

  if (req.method === "DELETE") {
    if (!email) { res.status(400).json({ error: "Missing email" }); return; }
    const { error } = await db.from("allowed_emails").delete().eq("email", email);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: "Use GET, POST, or DELETE" });
}

// Best-effort invite. New users get a Supabase invite email; users who already
// exist (e.g. tried to sign in before being allowlisted) can't be invited, so we
// send them a fresh magic-link sign-in instead. Either way they're allowlisted.
async function doInvite(db, email, site) {
  try {
    const r = await db.auth.admin.inviteUserByEmail(email, site ? { redirectTo: site } : undefined);
    if (!r || !r.error) return { ok: true, message: "invite email sent" };
    if (alreadyRegistered(r.error)) return await resendSignIn(email, site);
    return { ok: false, message: r.error.message || "invite failed" };
  } catch (e) {
    if (alreadyRegistered(e)) return await resendSignIn(email, site);
    return { ok: false, message: (e && e.message) ? e.message : "invite failed" };
  }
}

async function resendSignIn(email, site) {
  const anon = anonClient();
  try {
    const { error } = await anon.auth.signInWithOtp({ email: email, options: site ? { emailRedirectTo: site } : undefined });
    if (error) return { ok: true, message: "already had an account — they can sign in now (sign-in email not sent: " + error.message + ")" };
    return { ok: true, message: "already had an account — sent a fresh sign-in link" };
  } catch (e) {
    return { ok: true, message: "already had an account — they can just sign in now" };
  }
}

function alreadyRegistered(err) {
  if (!err) return false;
  const code = err.code || err.error_code || "";
  const msg = String(err.message || "").toLowerCase();
  return code === "email_exists" || msg.indexOf("already been registered") > -1 || msg.indexOf("already registered") > -1;
}

function siteUrl(req) {
  const h = req.headers || {};
  const host = h["x-forwarded-host"] || h.host;
  const proto = h["x-forwarded-proto"] || "https";
  return host ? proto + "://" + host : (process.env.SITE_URL || "");
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
