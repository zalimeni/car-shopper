// MarketCheck quota bookkeeping for the gauge + modal. Pure (no DOM / network).
//
// What we can know: every MarketCheck response carries the key's monthly
// Quota-Limit / Quota-Remaining / Quota-Reset-Time. MarketCheck has no free way
// to read them: no usage endpoint, and any request — even one that errors — is a
// billed call. So we never spend a call just to look: syncs and live Price Check
// searches hand the headers back per key (api/marketcheck.js `keyQuotas`) and we
// keep the latest snapshot per key in settings.mcQuota (synced across devices).
// Nothing here polls.
//
// Keys are used strictly in order (your keys top-to-bottom), spilling to the next
// only when one's monthly quota is spent — so total remaining capacity is simply
// the sum across keys, and "where we are" is the first key with calls left. The
// shared server key is used only when you have no keys of your own.

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

// The free plan's monthly allowance. One of your keys that's never been used (so
// MarketCheck hasn't reported its counter yet) is presumed to have this much until
// its first call says otherwise — reading it any sooner would cost a call.
export const FREE_PLAN_CALLS = 500;

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

// -> { rows, totalRemaining, totalLimit, fraction, unknown, presumed, activeId, nextReset }
// `presumed` = your keys with no report yet, counted at FREE_PLAN_CALLS; `unknown` =
// rows we can't estimate at all (only the shared server key, whose plan we don't know).
export function summarize(userKeys, store, nowMs) {
  const snaps = (store && store.snaps) || {};
  const now = nowMs != null ? nowMs : Date.now();
  const rows = keyRows(userKeys).map(function (row) {
    let e = effective(snaps[row.id], now);
    if (!e.known && !row.shared) e = { known: true, assumed: false, presumed: true, remaining: FREE_PLAN_CALLS, limit: FREE_PLAN_CALLS, reset: null, at: null };
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
  const presumed = rows.filter(function (r) { return r.presumed; }).length;
  return { rows: rows, totalRemaining: totalRemaining, totalLimit: totalLimit, fraction: fl > 0 ? fr / fl : null, unknown: unknown, presumed: presumed, activeId: activeId, nextReset: nextReset };
}

// Ids of the keys whose stored snapshot says this month's quota is used up (and
// hasn't reset yet). Sent with a sync so the server starts on the first live key
// instead of spending a call per request to rediscover that a key is spent.
export function spentKeyIds(userKeys, store, nowMs) {
  return summarize(userKeys, store, nowMs).rows.filter(function (r) { return r.state === "spent"; }).map(function (r) { return r.id; });
}

// Whole syncs the remaining calls cover, best case (cheapest) and worst case, for a
// cost estimate { min, max } (src/syncPlan.js estimateCost). Null with nothing to divide by.
export function syncsLeft(remaining, cost) {
  if (remaining == null || !cost || !cost.min) return null;
  return { best: Math.floor(remaining / cost.min), worst: Math.floor(remaining / cost.max) };
}


// Usage-bar colour by share USED (the bar fills up as calls are spent, like
// Claude's usage meter): neutral until three-quarters used, then amber, red from
// 90%; grey when unknown.
export function gaugeTone(used) {
  if (used == null) return "none";
  return used >= 0.9 ? "bad" : used >= 0.75 ? "warn" : "ok";
}
