// MarketCheck quota bookkeeping for the gauge + modal. Pure (no DOM / network).
//
// What we can know: every MarketCheck response carries the key's monthly
// Quota-Limit / Quota-Remaining / Quota-Reset-Time. Syncs hand those back per key
// (api/marketcheck.js `keyQuotas`), and an explicit probe (api/quota.js) reads
// them at the cost of one call per key. We keep the latest snapshot per key in
// settings.mcQuota so it syncs across devices; nothing here polls.
//
// Keys are used strictly in order (user keys top-to-bottom, then the shared server
// key), spilling to the next only when one is spent — so total remaining capacity
// is simply the sum across keys, and "where we are" is the first key with calls left.

// Mirrors api/marketcheck.js: 2 car types (used + certified) per profile x location,
// each paged 50 rows at a time up to MARKETCHECK_MAX_ROWS (default 200 -> 4 pages).
export const CAR_TYPES = 2;
export const MAX_PAGES = 4;

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
// The shared server key is listed when we've heard from it, or when there's nothing else.
export function keyRows(userKeys, snaps) {
  const rows = (userKeys || []).filter(function (k) { return k && (k.key || typeof k === "string"); }).map(function (k, i) {
    const key = typeof k === "string" ? k : k.key;
    const id = keyIdOf(key);
    return { id: id, shared: false, label: (typeof k === "object" && k.label) || "Key " + (i + 1), tail: "…" + id };
  });
  if ((snaps && snaps.shared) || !rows.length) rows.push({ id: "shared", shared: true, label: "Shared app key", tail: "" });
  return rows;
}

// -> { rows, totalRemaining, totalLimit, fraction, unknown, activeId, nextReset }
export function summarize(userKeys, store, nowMs) {
  const snaps = (store && store.snaps) || {};
  const now = nowMs != null ? nowMs : Date.now();
  const rows = keyRows(userKeys, snaps).map(function (row) {
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

// Calls one sync costs: profiles x locations x car types x pages. Pages depend on
// how many cars match (50 per page, up to MAX_PAGES), so it's a range until a
// real sync tells us (`measured`).
export function syncCost(activeProfiles, hubs, lastSync) {
  const P = activeProfiles || 0, H = hubs || 0;
  const min = P * H * CAR_TYPES;
  return {
    profiles: P, hubs: H, min: min, max: min * MAX_PAGES,
    measured: lastSync && lastSync.calls > 0 ? lastSync.calls : null,
    perHub: { min: P * CAR_TYPES, max: P * CAR_TYPES * MAX_PAGES },
    liveSearch: { min: H * CAR_TYPES, max: H * CAR_TYPES * MAX_PAGES },
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
