// Admin-only management of the email allowlist (public.allowed_emails).
//
//   GET                                   — list { email, added_at, is_admin, scheduled_sync,
//                                           last_scheduled_sync, last_scheduled_sync_result }
//   POST   { email, invite? }             — add to the allowlist; optionally send a
//                                           Supabase invite email (the only way in:
//                                           the project has sign-ups turned off)
//   PATCH  { email, is_admin?, scheduled_sync? } — change a row's flags
//   PATCH  { email, reset_mfa: true }     — lockout recovery: delete every TOTP
//                                           factor of that account (lost phone);
//                                           they sign in by email alone again
//   DELETE { email }                      — remove from the allowlist
//
// GET rows also carry `mfa`: how many verified two-factor apps the account
// has (null: no account yet, or the Auth admin API didn't answer).
//
// The table is RLS-locked with no client policies, so this reaches it via the
// service-role client (SUPABASE_SECRET_KEY). Gated to admins (allowed_emails
// .is_admin) — a non-admin user gets 403 — and to an aal2 session: admins must
// use two-factor (requireAdmin(), code mfa_enroll_required until they enroll).
// An admin can't remove or demote themselves, so the app can't be left
// without one.

import { authorize, deny, requireAdmin } from "./_auth.js";
import { adminClient, anonClient } from "./_supabaseAdmin.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { deny(res, auth); return; }
  const notAdmin = requireAdmin(auth);
  if (notAdmin) { deny(res, notAdmin); return; }

  const db = adminClient();
  if (!db) { res.status(500).json({ error: "Supabase secret key is not configured on the server" }); return; }

  if (req.method === "GET") {
    const { data, error } = await db.from("allowed_emails").select("*").order("added_at", { ascending: true });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ emails: await withMfa(db, data || []) });
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

  if (req.method === "PATCH" && body.reset_mfa === true) {
    if (!email) { res.status(400).json({ error: "Missing email" }); return; }
    if (email === self) { res.status(400).json({ error: "Remove your own two-factor apps in Settings" }); return; }
    const r = await resetMfa(db, email);
    res.status(r.error ? r.status : 200).json(r.error ? { error: r.error } : { ok: true, removed: r.removed });
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

// Every auth user, paged through the Auth admin API (a handful here; capped).
async function allUsers(db) {
  const users = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page: page, perPage: 1000 });
    if (error) throw error;
    const batch = (data && data.users) || [];
    users.push.apply(users, batch);
    if (batch.length < 1000) break;
  }
  return users;
}

function verifiedFactors(user) {
  return ((user && user.factors) || []).filter(function (f) { return f.status === "verified"; }).length;
}

// Best-effort: the list still loads if the Auth admin API doesn't answer.
async function withMfa(db, rows) {
  let byEmail = null;
  try {
    byEmail = {};
    (await allUsers(db)).forEach(function (u) { if (u.email) byEmail[u.email.toLowerCase()] = u; });
  } catch (e) { byEmail = null; }
  return rows.map(function (r) {
    const u = byEmail && byEmail[String(r.email).toLowerCase()];
    return Object.assign({}, r, { mfa: u ? verifiedFactors(u) : null });
  });
}

// Lockout recovery: delete all of an account's MFA factors (verified or not)
// with the service role. Their existing sessions stay as they are; the next
// email sign-in is all they need, and they can enroll again in Settings.
async function resetMfa(db, email) {
  let user = null;
  try {
    user = (await allUsers(db)).find(function (u) { return String(u.email || "").toLowerCase() === email; }) || null;
  } catch (e) { return { error: "Couldn't look up the account: " + (e.message || e), status: 502 }; }
  if (!user) return { error: "No account for " + email + " yet", status: 404 };
  const listed = await db.auth.admin.mfa.listFactors({ userId: user.id });
  if (listed.error) return { error: listed.error.message || "Couldn't list factors", status: 502 };
  const factors = (listed.data && listed.data.factors) || [];
  for (const f of factors) {
    const del = await db.auth.admin.mfa.deleteFactor({ userId: user.id, id: f.id });
    if (del.error) return { error: del.error.message || "Couldn't remove a factor", status: 502 };
  }
  return { removed: factors.length };
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
