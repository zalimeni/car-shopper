// Daily maintenance cron (Vercel Cron — see "crons" in vercel.json).
//
// Always: pings Supabase (keepalive) so a free-tier project doesn't auto-pause.
// Optionally (when CRON_SECRET is set): runs the scheduled background sync.
//
// Runs the same search + reconcile pipeline as the in-app sync, server-side,
// for the accounts in CRON_SYNC_EMAILS (default: the owner). Price changes and
// last-seen updates are written straight into the user's app_state blob
// (flagged reviewPending, same as an in-app sync); brand-new VINs are parked
// in the review queue (data.candidates, flagged fromScheduled), which the client
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
import { adminClient, anonClient } from "./_supabaseAdmin.js";
import { createSession, runStep, resolveKeys, keyId } from "./marketcheck.js";
import { reconcile } from "../src/reconcile.js";
import { ingestSnaps, spentKeyIds } from "../src/quota.js";
import { planSync, runSync, trackedVins, nextProfileMeta, mergeColorCache } from "../src/syncPlan.js";

const QUEUE_MAX = 300; // the review queue's cap (same as the app's), so the blob stays bounded

export default async function handler(req, res) {
  // Keepalive: touch the database on every daily cron run so a free-tier
  // Supabase project doesn't auto-pause after ~7 days of inactivity (a paused
  // project's host stops resolving, which breaks sign-in). Runs regardless of
  // whether scheduled sync is enabled; best-effort, never fails the request.
  try {
    const ka = adminClient() || anonClient();
    if (ka) await ka.from("app_state").select("user_id", { head: true, count: "exact" });
  } catch (e) { /* keepalive is best-effort */ }

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
  // The shared key is only a fallback now — a user's own keys are enough on their own.
  const apiKey = process.env.MARKETCHECK_API_KEY || "";

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
      if (!profiles.length) { out.skipped = "no active profiles"; continue; }

      const budgetMs = deadline - Date.now() - 2000;
      if (budgetMs < 5000) { out.skipped = "out of time this run"; continue; }
      const dealerType = state.settings && state.settings.franchiseOnly ? "franchise" : null;
      // The user's own keys, in order — or the shared key only if they have none.
      const resolved = resolveKeys(((state.settings && state.settings.marketcheckKeys) || [])
        .map(function (k) { return (k && k.key ? k.key : k) || ""; }), apiKey);
      const keys = resolved.keys;
      if (!keys.length) { out.skipped = "no MarketCheck key (add one in Settings, or set MARKETCHECK_API_KEY)"; continue; }
      // The same plan as the in-app sync's automatic path: full refresh when due,
      // else new listings, then the watchlist's leftover VINs (src/syncPlan.js).
      const settings = state.settings || {};
      const planOpts = { franchiseOnly: !!settings.franchiseOnly, excludeSalt: settings.saltMode !== "flag" };
      const steps = planSync(profiles, settings.mcProfiles || {}, planOpts);
      const keyIds = keys.map(function (k) { return keyId(k, resolved.shared ? apiKey : null); });
      const spent = spentKeyIds(settings.marketcheckKeys || [], settings.mcQuota);
      const r = await runSync(steps, trackedVins(state.listings), async function (step) {
        // A fresh session per step (so each report is that step's alone), carrying
        // forward the keys found spent and the shared time budget.
        const sess = createSession(keys, { dealerType: dealerType, keyIds: keyIds, spentKeys: spent, budgetMs: Math.max(1000, deadline - Date.now() - 2000) });
        const rep = await runStep(sess, Object.assign({}, step, { excludeSalt: planOpts.excludeSalt }));
        (rep.keyQuotas || []).forEach(function (q) { if (q && q.exhausted && spent.indexOf(q.id) < 0) spent.push(q.id); });
        return rep;
      }, null, { colorCache: settings.mcColors || {} });

      const rec = reconcile(state.listings || [], r.listings, todayStr, { goneVins: r.goneVins });

      // Add genuinely-new candidates to the review queue (data.candidates — the
      // same synced queue the app uses): drop VINs the user skipped and VINs
      // already queued. Flagged fromScheduled so the app can say how many arrived.
      const skip = {};
      (state.skipped || []).forEach(function (s) { if (s.vin) skip[s.vin] = true; });
      const queue = (Array.isArray(state.candidates) ? state.candidates : []).concat(Array.isArray(state.pendingCandidates) ? state.pendingCandidates : []);
      const queued = {};
      queue.forEach(function (c) { if (c && c.vin) queued[c.vin] = true; });
      const fresh = rec.candidates.filter(function (c) { return c.vin && !skip[c.vin] && !queued[c.vin]; })
        .map(function (c) { return Object.assign({}, c, { _candidate: true, fromScheduled: true }); });
      let newQueue = queue.concat(fresh);
      if (newQueue.length > QUEUE_MAX) newQueue = newQueue.slice(newQueue.length - QUEUE_MAX);

      const nextData = Object.assign({}, state, {
        listings: rec.listings,
        candidates: newQueue,
      });
      delete nextData.pendingCandidates;
      // Same API-version bookkeeping as the in-app sync (drift banner).
      const nowIso = new Date().toISOString();
      nextData.settings = Object.assign({}, settings, {
          mcProfiles: nextProfileMeta(settings.mcProfiles, r.results, planOpts, nowIso),
          mcColors: mergeColorCache(settings.mcColors, r.decoded, nowIso),
          mcQuota: ingestSnaps(settings.mcQuota, r.keyQuotas, nowIso) },
        r.apiInfo ? { mcApi: Object.assign({}, r.apiInfo, { at: nowIso }) } : {});
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
