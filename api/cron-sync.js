// Scheduled background sync (Vercel Cron — see "crons" in vercel.json).
//
// Runs the same search + reconcile pipeline as the in-app sync, server-side,
// for the accounts in CRON_SYNC_EMAILS (default: the owner). Price changes and
// last-seen updates are written straight into the user's app_state blob
// (flagged reviewPending, same as an in-app sync); brand-new VINs are parked
// in data.pendingCandidates, which the client drains into its candidate review
// queue on next open. No AI scoring here — that stays a client-initiated
// action against the user's own key/quota.
//
// Scheduled sync is OFF BY DEFAULT: the endpoint does nothing (a clean no-op)
// unless CRON_SECRET (≥16 chars) is configured — so the daily Vercel cron can't
// burn MarketCheck quota until you deliberately opt in by setting the key.
//
// Auth: Vercel invokes the path with `Authorization: Bearer $CRON_SECRET` when
// the CRON_SECRET env var is set. Requests without the exact secret are
// rejected. Writes are compare-and-swap on app_state.rev — if the user is
// actively using the app when the cron fires, the cron loses and leaves their
// state alone.

import { safeEqual, DEFAULT_ALLOW } from "./_auth.js";
import { adminClient } from "./_supabaseAdmin.js";
import { searchListings } from "./marketcheck.js";
import { reconcile } from "../src/reconcile.js";

const PENDING_MAX = 100; // cap parked candidates so the blob stays bounded

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const header = req.headers.authorization || "";
  const token = header.indexOf("Bearer ") === 0 ? header.slice(7).trim() : "";
  // Disabled by default: no CRON_SECRET → scheduled sync is off. Return a clean
  // no-op (not an error) so the daily cron invocation is harmless until enabled.
  if (secret.length < 16) {
    res.status(200).json({ ok: true, disabled: true, message: "Scheduled sync is disabled — set CRON_SECRET (>= 16 chars) to enable." });
    return;
  }
  if (!safeEqual(token, secret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const db = adminClient();
  if (!db) { res.status(500).json({ error: "Supabase secret key is not configured on the server" }); return; }
  const apiKey = process.env.MARKETCHECK_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "MARKETCHECK_API_KEY is not configured on the server" }); return; }

  const emails = (process.env.CRON_SYNC_EMAILS || DEFAULT_ALLOW)
    .split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);

  // Resolve the target emails to auth users (few users; paging is a formality).
  const users = [];
  for (let page = 1; page <= 10; page++) {
    const r = await db.auth.admin.listUsers({ page: page, perPage: 200 });
    if (r.error) { res.status(500).json({ error: "listUsers: " + r.error.message }); return; }
    const batch = (r.data && r.data.users) || [];
    batch.forEach(function (u) {
      if (u.email && emails.indexOf(u.email.toLowerCase()) > -1) users.push(u);
    });
    if (batch.length < 200) break;
  }

  // One shared time budget across users, under the function's maxDuration.
  const deadline = Date.now() + (Number(process.env.MARKETCHECK_BUDGET_MS) || 50000);
  const todayStr = new Date().toISOString().split("T")[0];
  const report = [];

  for (const u of users) {
    const out = { email: u.email };
    report.push(out);
    try {
      const row = await db.from("app_state").select("data,rev").eq("user_id", u.id).maybeSingle();
      if (row.error) { out.error = row.error.message; continue; }
      if (!row.data || !row.data.data) { out.skipped = "no saved data"; continue; }
      const state = row.data.data;
      const profiles = (state.profiles || []).filter(function (p) { return p.active; });
      const hubs = (state.settings && state.settings.hubs) || [];
      if (!profiles.length || !hubs.length) { out.skipped = "no active profiles or search locations"; continue; }

      const budgetMs = deadline - Date.now() - 2000;
      if (budgetMs < 5000) { out.skipped = "out of time this run"; continue; }
      const dealerType = state.settings && state.settings.franchiseOnly ? "franchise" : null;
      const r = await searchListings(
        apiKey,
        profiles.map(function (p) { return { id: p.id, name: p.name, params: p.params }; }),
        hubs,
        { dealerType: dealerType, budgetMs: budgetMs }
      );

      const rec = reconcile(state.listings || [], r.listings, todayStr);

      // Park genuinely-new candidates: drop VINs the user skipped and VINs
      // already parked by a previous cron run. (The client also dedups against
      // its live queue when it drains these.)
      const skip = {};
      (state.skipped || []).forEach(function (s) { if (s.vin) skip[s.vin] = true; });
      const pending = Array.isArray(state.pendingCandidates) ? state.pendingCandidates.slice() : [];
      const pendVins = {};
      pending.forEach(function (c) { if (c.vin) pendVins[c.vin] = true; });
      const fresh = rec.candidates.filter(function (c) { return c.vin && !skip[c.vin] && !pendVins[c.vin]; });
      let newPending = pending.concat(fresh);
      if (newPending.length > PENDING_MAX) newPending = newPending.slice(newPending.length - PENDING_MAX);

      const nextData = Object.assign({}, state, {
        listings: rec.listings,
        pendingCandidates: newPending,
      });
      // Don't advance lastSynced on an incomplete (rate-limited) run — leave it
      // at the last good sync so the "Last synced" display isn't misleading.
      if (!r.rateLimited) nextData.lastSynced = new Date().toISOString();

      // Compare-and-swap; on mismatch the user's device wrote mid-run — leave
      // their state alone rather than retrying against a moving target.
      const w = await db.from("app_state")
        .update({ data: nextData, updated_at: new Date().toISOString(), rev: (row.data.rev || 0) + 1 })
        .eq("user_id", u.id).eq("rev", row.data.rev || 0)
        .select("rev");
      if (w.error) { out.error = w.error.message; continue; }
      if (!w.data || !w.data.length) { out.skipped = "state changed mid-run (device active) — left untouched"; continue; }

      out.summary = rec.summary;
      out.parkedCandidates = fresh.length;
      if (r.errors.length) out.queryErrors = r.errors.slice(0, 3);
    } catch (e) {
      out.error = (e && e.message) || "sync failed";
    }
  }

  res.status(200).json({ ok: true, matchedUsers: users.length, report: report });
}
