// What a sync does, and what it costs. Pure apart from the injected `exec`, so the
// browser (src/sync.js, one HTTP request per step) and the scheduled sync
// (api/cron-sync.js, direct calls) run the exact same plan.
//
// Every MarketCheck call is billed and every 50 cars is a call, so a sync does as
// little as it can:
//   1. Each active profile runs ONE nationwide search (salt states excluded via
//      `state=`, or flagged — Settings), either
//        - a FULL refresh: every matching car. Due when never run, after 3 days,
//          when the profile's search filters changed, or on a manual Sync.
//          Catches older listings that newly match (a price drop under the cap).
//        - otherwise NEW LISTINGS only: newest-at-this-dealer first (dos_active),
//          stopping once past the days since the profile's last search.
//   2. The watchlist's VINs that step 1 didn't return are looked up directly,
//      50 per call. One the lookup doesn't return either is no longer listed —
//      the only way a car is marked gone, so it's never a guess.
//   3. Cars whose listing has no color get it from MarketCheck's VIN decoder
//      (NeoVIN: the factory build data) — one call per car, at most DECODE_MAX a
//      sync, each VIN only ever once (remembered in settings.mcColors).

import { parseYears, mapPowertrain } from "./queryPlan.js";
import { mergeReports } from "./quota.js";

export const FULL_REFRESH_DAYS = 3;
export const VIN_BATCH = 50;
export const ROWS = 50;          // MarketCheck page size
export const PAGE_CAP = 10;      // 500-row pagination ceiling
export const COUNT_WARN = 300;   // a profile matching more than this gets a "narrow it" warning
export const DECODE_MAX = 10;    // colorless cars decoded (NeoVIN, 1 call each) per sync, at most
const COLOR_CACHE_DAYS = 90, COLOR_CACHE_MAX = 1000;
const DAY = 86400000;

// The parts of a profile (and settings) that change what its search returns. A
// changed signature makes the profile due for a full refresh.
export function searchSig(profile, opts) {
  const p = (profile && profile.params) || {};
  const o = opts || {};
  return JSON.stringify([
    String(p.make || "").trim().toLowerCase(), String(p.model || "").trim().toLowerCase(),
    String(mapPowertrain(p.powertrain) || "").toLowerCase(), parseYears(p.years),
    Number(p.maxPrice) || 0, Number(p.maxMiles) || 0, !!o.franchiseOnly, !!o.excludeSalt,
  ]);
}

// Per-profile sync state (settings.mcProfiles[id]) -> what this profile needs now.
// -> { due, edited, count, countCurrent }
export function profileStatus(profile, meta, opts, nowMs) {
  const m = (meta && profile && meta[profile.id]) || null;
  const sig = searchSig(profile, opts);
  const now = nowMs != null ? nowMs : Date.now();
  const edited = !!(m && m.sig && m.sig !== sig);
  const due = !m || !m.fullAt || m.sig !== sig || now - Date.parse(m.fullAt) >= FULL_REFRESH_DAYS * DAY;
  return { due: due, edited: edited, count: m && m.count != null ? m.count : null, countCurrent: !!(m && m.countSig === sig) };
}

// -> [{ kind: "full" | "new", profile, since }]
export function planSync(profiles, meta, opts, nowMs) {
  const o = opts || {};
  const now = nowMs != null ? nowMs : Date.now();
  return (profiles || []).map(function (p) {
    const st = profileStatus(p, meta, o, now);
    if (o.manual || st.due) return { kind: "full", profile: p };
    const m = meta[p.id];
    const last = Date.parse(m.lastAt || m.fullAt);
    // Whole days since the last search, plus a day of overlap for timing slop.
    return { kind: "new", profile: p, since: Math.ceil((now - last) / DAY) + 1 };
  });
}

// VINs of the watchlist's dealer-synced listings — what step 2 keeps current.
export function trackedVins(listings) {
  const out = [], seen = {};
  (listings || []).forEach(function (l) {
    const v = String((l && l.vin) || "").trim().toUpperCase();
    if (!v || seen[v] || l.source !== "marketcheck" || l.status !== "watch") return;
    seen[v] = true;
    out.push(v);
  });
  return out;
}

// Fold a sync's per-profile results into settings.mcProfiles. A profile's search
// times only advance when its search finished without errors. (A search too big
// to page even after splitting still counts as done — its count warning says so —
// rather than re-running in full every sync.)
export function nextProfileMeta(meta, results, opts, nowIso) {
  const out = Object.assign({}, meta || {});
  (results || []).forEach(function (r) {
    if (!r || !r.profile) return;
    const id = r.profile.id;
    const sig = searchSig(r.profile, opts);
    const m = Object.assign({}, out[id] || {});
    if (r.numFound != null) { m.count = r.numFound; m.countSig = sig; m.countAt = nowIso; }
    // A full refresh also brings the profile's color breakdown (the editor's chips).
    if (r.colors) m.colors = Object.assign({}, r.colors, { at: nowIso });
    if (r.ok) {
      m.lastAt = nowIso;
      if (r.kind === "full") { m.fullAt = nowIso; m.sig = sig; }
    }
    out[id] = m;
  });
  return out;
}

// Calls one sync should take. -> { min, max, profiles: [{ id, kind, min, max }], vins: { min, max } }
// A full refresh pages every matching car (count known from earlier searches),
// plus a page-1 per extra state group when it's over the 500-row ceiling; unknown
// counts give the 1–10 page range. A new-listings pass is a page, rarely two.
export function estimateCost(profiles, meta, listings, opts, nowMs) {
  const o = opts || {};
  const plan = planSync(profiles, meta || {}, o, nowMs);
  let min = 0, max = 0;
  const per = plan.map(function (s) {
    let a, b;
    if (s.kind === "new") { a = 1; b = 2; }
    else {
      const st = profileStatus(s.profile, meta || {}, o, nowMs);
      if (st.count != null && st.countCurrent) {
        const pages = Math.max(1, Math.ceil(st.count / ROWS));
        const groups = Math.max(1, Math.ceil(st.count / (ROWS * PAGE_CAP)));
        a = b = pages + (groups > 1 ? groups - 1 : 0);
      } else { a = 1; b = PAGE_CAP; }
    }
    min += a; max += b;
    return { id: s.profile.id, kind: s.kind, min: a, max: b };
  });
  // After full refreshes most watched cars come back in the searches; after a
  // new-listings pass most don't. Either way at most one call per 50.
  const n = trackedVins(listings).length;
  const allFull = plan.length && plan.every(function (s) { return s.kind === "full"; });
  const vins = { min: allFull ? 0 : Math.min(1, n), max: Math.ceil(n / VIN_BATCH) };
  return { min: min + vins.min, max: max + vins.max, profiles: per, vins: vins };
}

// Run a planned sync. exec(step) performs one step — { kind: "full" | "new",
// profile, since } or { kind: "vins", vins } — and resolves to the proxy's report
// ({ listings, numFound, errors, notices, rateLimited, calls, ... }).
// onProgress({ done, total, label, listings }) after each step.
// opts.colorCache: settings.mcColors — VIN -> decoded color (or { color: null } for
// "decoded, none"), so a car is never decoded twice.
export async function runSync(steps, tracked, exec, onProgress, opts) {
  const colorCache = (opts && opts.colorCache) || {};
  const report = typeof onProgress === "function" ? onProgress : function () {};
  const out = {
    listings: [], results: [], goneVins: [], errors: [], notices: [], keyQuotas: [], calls: 0,
    apiInfo: null, formatSuspect: false, rateLimited: false, rateLimitInfo: null, quota: null, mock: false,
    decoded: {}, // VIN -> { color, baseColor } | null, decoded this sync (to remember)
  };
  const seen = {}; // vin -> listing (lowest real price wins)
  const take = function (r) {
    (r.listings || []).forEach(function (l) {
      const v = String((l && l.vin) || "").trim().toUpperCase();
      if (!v) return;
      const prev = seen[v];
      if (!prev || (l.price && (!prev.price || l.price < prev.price))) seen[v] = l;
    });
    (r.errors || []).forEach(function (m) { out.errors.push(m); });
    (r.notices || []).forEach(function (m) { if (out.notices.indexOf(m) < 0) out.notices.push(m); });
    out.keyQuotas = mergeReports(out.keyQuotas, r.keyQuotas);
    out.calls += r.calls || 0;
    if (r.apiInfo) out.apiInfo = r.apiInfo;
    if (r.formatSuspect) out.formatSuspect = true;
    if (r.mock) out.mock = true;
    if (r.rateLimited) { out.rateLimited = true; if (r.rateLimitInfo) out.rateLimitInfo = r.rateLimitInfo; }
    if (r.quota && r.quota.remaining != null && (out.quota == null || r.quota.remaining < out.quota.remaining)) out.quota = r.quota;
  };
  const failed = function (e) { return { errors: [(e && e.message) || "sync failed"], rateLimited: !!(e && e.rateLimited) }; };
  let total = steps.length + 1, done = 0;

  for (const s of steps) {
    let r;
    try { r = await exec(s); } catch (e) { r = failed(e); }
    take(r);
    const ok = !(r.errors && r.errors.length) && !r.rateLimited;
    out.results.push({ profile: s.profile, kind: s.kind, numFound: r.numFound != null ? r.numFound : null, colors: r.colors || null, ok: ok });
    report({ done: ++done, total: total, label: s.profile.name || s.profile.id, listings: Object.values(seen) });
    if (out.rateLimited) return finish();
  }

  // Watchlist cars the searches didn't return: look them up by VIN.
  const left = (tracked || []).filter(function (v) { return !seen[v]; });
  const batches = [];
  for (let i = 0; i < left.length; i += VIN_BATCH) batches.push(left.slice(i, i + VIN_BATCH));
  total = steps.length + Math.max(1, batches.length);
  for (const b of batches) {
    let r;
    try { r = await exec({ kind: "vins", vins: b }); } catch (e) { r = failed(e); }
    take(r);
    // Only a clean lookup proves a car is gone.
    if (!(r.errors && r.errors.length) && !r.rateLimited) b.forEach(function (v) { if (!seen[v]) out.goneVins.push(v); });
    report({ done: ++done, total: total, label: "watchlist", listings: Object.values(seen) });
    if (out.rateLimited) break;
  }
  if (out.rateLimited) return finish();

  // Fill missing colors: remembered decodes first, then NeoVIN for the rest (capped).
  const colorless = Object.keys(seen).filter(function (v) { return !seen[v].color && !seen[v].baseColor; });
  colorless.forEach(function (v) { if (colorCache[v] && colorCache[v].baseColor) applyColor(v, colorCache[v]); });
  const toDecode = colorless.filter(function (v) { return !(v in colorCache); }).slice(0, DECODE_MAX);
  if (toDecode.length) {
    let r;
    try { r = await exec({ kind: "decode", vins: toDecode }); } catch (e) { r = failed(e); }
    take(r);
    Object.keys(r.decoded || {}).forEach(function (v) {
      out.decoded[v] = r.decoded[v];
      if (r.decoded[v]) applyColor(v, r.decoded[v]);
    });
    report({ done: ++done, total: total + 1, label: "colors", listings: Object.values(seen) });
  }
  return finish();

  function applyColor(v, c) {
    seen[v] = Object.assign({}, seen[v], { color: c.color, baseColor: c.baseColor, colorSource: "neovin" });
  }

  function finish() {
    out.listings = Object.values(seen);
    return out;
  }
}

// Fold this sync's decodes into settings.mcColors (VIN -> { color, baseColor, at },
// color null = decoded, none found), dropping entries past 90 days and keeping
// the newest 1,000 so the blob stays bounded.
export function mergeColorCache(cache, decoded, nowIso) {
  const out = Object.assign({}, cache || {});
  Object.keys(decoded || {}).forEach(function (v) {
    const d = decoded[v];
    out[v] = d ? { color: d.color, baseColor: d.baseColor, at: nowIso } : { color: null, at: nowIso };
  });
  const cutoff = Date.parse(nowIso) - COLOR_CACHE_DAYS * DAY;
  const keys = Object.keys(out).filter(function (v) { return !(Date.parse(out[v].at) < cutoff); });
  keys.sort(function (a, b) { return String(out[b].at).localeCompare(String(out[a].at)); });
  const kept = {};
  keys.slice(0, COLOR_CACHE_MAX).forEach(function (v) { kept[v] = out[v]; });
  return kept;
}
