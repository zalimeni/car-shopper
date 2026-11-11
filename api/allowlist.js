// Admin-only management of the email allowlist (public.allowed_emails).
//
//   GET                                   — list { email, added_at, is_admin, scheduled_sync }
//   POST   { email, invite? }             — add to the allowlist; optionally send a
//                                           Supabase invite email (the only way in:
//                                           the project has sign-ups turned off)
//   PATCH  { email, is_admin?, scheduled_sync? } — change a row's flags
//   DELETE { email }                      — remove from the allowlist
//
// The table is RLS-locked with no client policies, so this reaches it via the
// service-role client (SUPABASE_SECRET_KEY). Gated to admins (allowed_emails
// .is_admin) — a non-admin user gets 403. An admin can't remove or demote
// themselves, so the app can't be left without one.

import { authorize } from "./_auth.js";
import { adminClient, anonClient } from "./_supabaseAdmin.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  if (!auth.admin) { res.status(403).json({ error: "Admins only" }); return; }

  const db = adminClient();
  if (!db) { res.status(500).json({ error: "Supabase secret key is not configured on the server" }); return; }

  if (req.method === "GET") {
    const { data, error } = await db.from("allowed_emails").select("email,added_at,is_admin,scheduled_sync").order("added_at", { ascending: true });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ emails: data || [] });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const self = String(auth.user.email || "").toLowerCase();

  if (req.method === "POST") {
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: "Enter a valid email address" }); return; }
    const { error } = await db.from("allowed_emails").upsert({ email: email }, { onConflict: "email", ignoreDuplicates: true });
    if (error) { res.status(500).json({ error: error.message }); return; }

    // The allowlist row is written regardless — the person is approved now.
    // Invite is best-effort and reported separately.
    let invite = null;
    if (body.invite) invite = await doInvite(db, email);
    res.status(200).json({ ok: true, email: email, invite: invite });
    return;
  }

  if (req.method === "PATCH") {
    if (!email) { res.status(400).json({ error: "Missing email" }); return; }
    const patch = {};
    if (typeof body.is_admin === "boolean") patch.is_admin = body.is_admin;
    if (typeof body.scheduled_sync === "boolean") patch.scheduled_sync = body.scheduled_sync;
    if (!Object.keys(patch).length) { res.status(400).json({ error: "Nothing to change" }); return; }
    if (email === self && patch.is_admin === false) { res.status(400).json({ error: "You can't remove your own admin access" }); return; }
    const { error } = await db.from("allowed_emails").update(patch).eq("email", email);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === "DELETE") {
    if (!email) { res.status(400).json({ error: "Missing email" }); return; }
    if (email === self) { res.status(400).json({ error: "You can't remove yourself" }); return; }
    const { error } = await db.from("allowed_emails").delete().eq("email", email);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: "Use GET, POST, PATCH, or DELETE" });
}

// Best-effort invite. New users get a Supabase invite email (it links to the
// project's Site URL). Users who already exist can't be invited, so they get a
// fresh sign-in email instead. Either way they're allowlisted.
async function doInvite(db, email) {
  try {
    const r = await db.auth.admin.inviteUserByEmail(email);
    if (!r || !r.error) return { ok: true, message: "invite email sent" };
    if (alreadyRegistered(r.error)) return await resendSignIn(email);
    return { ok: false, message: r.error.message || "invite failed" };
  } catch (e) {
    if (alreadyRegistered(e)) return await resendSignIn(email);
    return { ok: false, message: (e && e.message) ? e.message : "invite failed" };
  }
}

async function resendSignIn(email) {
  const anon = anonClient();
  try {
    const { error } = await anon.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false } });
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

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
