// MarketCheck quota bookkeeping for the gauge + modal. Pure (no DOM / network).
//
// What we can know: every MarketCheck response carries the key's monthly
// Quota-Limit / Quota-Remaining / Quota-Reset-Time. Syncs hand those back per key
// (api/marketcheck.js `keyQuotas`), and an explicit probe (api/quota.js) reads
// them at the cost of one call per key. We keep the latest snapshot per key in
// settings.mcQuota so it syncs across devices; nothing here polls.
//
// Keys are used strictly in order (your keys top-to-bottom), spilling to the next
// only when one's monthly quota is spent — so total remaining capacity is simply
// the sum across keys, and "where we are" is the first key with calls left. The
// shared server key is used only when you have no keys of your own.

import { groupProfiles } from "./queryPlan.js";

// Mirrors api/marketcheck.js: one car type (used — it includes certified), 50 rows
// per page, up to 200 rows per profile (4 pages), and never past the account's
// 500-row pagination ceiling (10 pages) for a merged query.
export const ROWS = 50;
export const MAX_PAGES = 4;
export const PAGE_CEILING = 10;

// Settings' save step: trim, drop blanks, and drop repeats of the same key (first
// wins, but it adopts a later copy's label if it had none). This is the ONLY place
// duplicates are handled — everything else assumes the saved list is already clean.
export function dedupeKeyEntries(entries) {
  const out = [];
  const at = {};
  (entries || []).forEach(function (e) {
    const key = String((e && e.key) || "").trim();
    if (!key) return;
    const label = String((e && e.label) || "").trim();
    if (at[key] != null) { if (!out[at[key]].label && label) out[at[key]].label = label; return; }
    at[key] = out.length;
    out.push({ key: key, label: label });
  });
  return out;
}

export function keyIdOf(key) { return String(key || "").slice(-4); }

// Merge snapshots reported by the server ([{ id, remaining, limit, reset, exhausted }])
// into the stored { snaps, lastSync }. Newer reports replace older ones per key; a
// field the new report lacks keeps its previous value so a sparse report can't blank it.
export function ingestSnaps(prev, reports, nowIso) {
  const out = { snaps: Object.assign({}, (prev && prev.snaps) || {}), lastSync: (prev && prev.lastSync) || null };
  (reports || []).forEach(function (r) {
    if (!r || !r.id) return;
    const old = out.snaps[r.id] || {};
    out.snaps[r.id] = {
      remaining: r.remaining != null ? r.remaining : (r.exhausted ? 0 : old.remaining != null ? old.remaining : null),
      limit: r.limit != null ? r.limit : (old.limit != null ? old.limit : null),
      reset: r.reset || old.reset || null,
      exhausted: !!r.exhausted,
      at: nowIso,
    };
  });
  return out;
}

// Remember how many calls the last COMPLETE sync actually cost (partial,
// rate-limited runs under-count, so callers only pass complete ones).
export function recordSyncCalls(prev, calls, nowIso) {
  const out = { snaps: Object.assign({}, (prev && prev.snaps) || {}), lastSync: (prev && prev.lastSync) || null };
  if (calls > 0) out.lastSync = { calls: calls, at: nowIso };
  return out;
}

// Combine per-hub reports from one multi-request sync: per key keep the report
// with the least remaining (counters only fall), and an exhausted flag sticks.
export function mergeReports(a, b) {
  const byId = {};
  (a || []).concat(b || []).forEach(function (r) {
    if (!r || !r.id) return;
    const p = byId[r.id];
    if (!p) { byId[r.id] = Object.assign({}, r); return; }
    const lower = r.remaining != null && (p.remaining == null || r.remaining < p.remaining);
    byId[r.id] = Object.assign({}, p, lower ? r : {}, { exhausted: !!(p.exhausted || r.exhausted), limit: r.limit != null ? r.limit : p.limit, reset: r.reset || p.reset });
  });
  return Object.keys(byId).map(function (k) { return byId[k]; });
}

// A snapshot whose reset time has passed describes last month's counter: the
// quota has renewed, so assume it's full again (flagged `assumed`) until re-read.
function effective(snap, nowMs) {
  if (!snap || (snap.remaining == null && !snap.exhausted)) return { known: false };
  const resetMs = snap.reset ? Date.parse(snap.reset) : NaN;
  if (!isNaN(resetMs) && resetMs <= nowMs && snap.limit) {
    return { known: true, assumed: true, remaining: snap.limit, limit: snap.limit, reset: null, at: snap.at };
  }
  return { known: true, assumed: false, remaining: snap.remaining == null ? 0 : snap.remaining, limit: snap.limit, reset: snap.reset, at: snap.at };
}

// The keys in the order they're used. `userKeys` = [{ key, label }] from settings.
// If there's a configured list at all the shared server key is ignored entirely — never a row, never in the totals,
// even if an old snapshot for it is lying around; it appears only when the list is empty.
export function keyRows(userKeys) {
  const rows = [];
  (userKeys || []).forEach(function (k) {
    const key = typeof k === "string" ? k : (k && k.key) || "";
    if (!key) return;
    const id = keyIdOf(key);
    rows.push({ id: id, shared: false, label: (typeof k === "object" && k.label) || "Key " + (rows.length + 1), tail: "…" + id });
  });
  if (!rows.length) rows.push({ id: "shared", shared: true, label: "Shared app key", tail: "" });
  return rows;
}

// -> { rows, totalRemaining, totalLimit, fraction, unknown, activeId, nextReset }
export function summarize(userKeys, store, nowMs) {
  const snaps = (store && store.snaps) || {};
  const now = nowMs != null ? nowMs : Date.now();
  const rows = keyRows(userKeys).map(function (row) {
    const e = effective(snaps[row.id], now);
    return Object.assign({}, row, e);
  });
  let totalRemaining = 0, totalLimit = 0, unknown = 0, activeId = null, nextReset = null;
  rows.forEach(function (r) {
    if (!r.known) { unknown++; if (!activeId) activeId = r.id; return; }
    totalRemaining += r.remaining;
    if (r.limit != null) totalLimit += r.limit;
    if (r.remaining > 0 && !activeId) activeId = r.id;
    if (r.reset) { const t = Date.parse(r.reset); if (!isNaN(t) && t > now && (nextReset == null || t < nextReset)) nextReset = t; }
  });
  rows.forEach(function (r) {
    r.state = !r.known ? "unmeasured" : r.remaining <= 0 ? "spent" : r.id === activeId ? "in use" : "standby";
  });
  // Fraction only over keys whose limit we know, so an unmeasured key can't skew it.
  let fr = 0, fl = 0;
  rows.forEach(function (r) { if (r.known && r.limit) { fr += r.remaining; fl += r.limit; } });
  return { rows: rows, totalRemaining: totalRemaining, totalLimit: totalLimit, fraction: fl > 0 ? fr / fl : null, unknown: unknown, activeId: activeId, nextReset: nextReset };
}

// Ids of the keys whose stored snapshot says this month's quota is used up (and
// hasn't reset yet). Sent with a sync so the server starts on the first live key
// instead of spending a call per request to rediscover that a key is spent.
export function spentKeyIds(userKeys, store, nowMs) {
  return summarize(userKeys, store, nowMs).rows.filter(function (r) { return r.state === "spent"; }).map(function (r) { return r.id; });
}

// Identity of what a sync searches (active profiles + their filters, locations),
// so a measured cost is only reused for the same plan — add a location and the
// last sync's call count no longer says anything.
export function planSig(activeProfiles, hubs) {
  const ps = (activeProfiles || []).map(function (p) { return (p && p.id) + ":" + JSON.stringify((p && p.params) || {}); }).sort();
  const hs = (hubs || []).map(function (h) { return [h.lat, h.lon, h.z, h.r].join(":"); }).sort();
  return ps.join("|") + "#" + hs.join("|");
}

// Mirrors api/marketcheck.js geoHubs: a nationwide search needs every location's coordinates.
function nationalOk(hubs) {
  return Array.isArray(hubs) && hubs.length > 1 && hubs.every(function (h) { return isFinite(parseFloat(h && h.lat)) && isFinite(parseFloat(h && h.lon)); });
}

// Calls one sync costs. All active profiles share one query (src/queryPlan.js —
// the same grouping the server uses). With 2+ locations that all have coordinates
// the sync first tries ONE nationwide search, kept to your locations' radii
// locally: 1–10 pages when it fits, else one wasted page and per-location searches
// (the old plan: a page per location, more for dense ones). Pages depend on how
// many cars match, so it's a range until a real sync of the same plan measures it.
// `hubs` is the locations array (a bare count = per-location only, no plan check).
export function syncCost(activeProfiles, hubs, lastSync) {
  const groups = Array.isArray(activeProfiles) ? groupProfiles(activeProfiles) : Array.from({ length: activeProfiles || 0 }, function () { return [null]; });
  const P = groups.reduce(function (a, g) { return a + g.length; }, 0);
  const H = Array.isArray(hubs) ? hubs.length : (hubs || 0);
  const G = groups.length;
  const pagesMax = groups.reduce(function (a, g) { return a + Math.min(PAGE_CEILING, MAX_PAGES * g.length); }, 0);
  const national = nationalOk(hubs) && G > 0;
  // A measurement counts only for the plan it measured (when we can tell).
  const samePlan = !Array.isArray(hubs) || !Array.isArray(activeProfiles) || (lastSync && lastSync.plan === planSig(activeProfiles, hubs));
  return {
    profiles: P, groups: G, hubs: H, national: national,
    min: national ? G : G * H,
    max: (national ? G : 0) + pagesMax * H,
    measured: samePlan && lastSync && lastSync.calls > 0 ? lastSync.calls : null,
    perHub: { min: G, max: pagesMax },
    // Price Check's live search runs one query around the home base.
    liveSearch: { min: 1, max: MAX_PAGES },
  };
}

// Whole syncs the remaining calls cover: best case (cheapest), worst case, and at the
// last measured cost. Null when there's nothing to divide by.
export function syncsLeft(remaining, cost) {
  if (remaining == null || !cost || !cost.min) return null;
  return {
    best: Math.floor(remaining / cost.min),
    worst: Math.floor(remaining / cost.max),
    measured: cost.measured ? Math.floor(remaining / cost.measured) : null,
  };
}

// good / warn / bad by share of capacity left; null when we can't tell.
export function gaugeTone(fraction) {
  if (fraction == null) return "none";
  return fraction >= 0.4 ? "good" : fraction >= 0.15 ? "warn" : "bad";
}
