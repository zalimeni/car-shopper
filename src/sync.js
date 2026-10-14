// Client-side sync (sync-on-open + "Sync now").
//
// Pulls dealer inventory via the /api/marketcheck proxy and reconciles it
// against the stored listings. Runs in the browser under the user's Supabase
// session, so every write goes through normal RLS — no service-role key.
//
// Split of responsibilities:
//   - fetchListings(): talk to the proxy, return normalized listings.
//   - reconcile():     pure function, lives in src/reconcile.js (shared with
//                      the server-side scheduled sync) and re-exported here.

import { supabase } from "./supabaseClient";
import { mergeReports } from "./quota.js";

// Ids of the keys a batch of per-key reports says are spent this month.
function spentIn(reports) {
  return (reports || []).filter(function (r) { return r && r.exhausted && r.id; }).map(function (r) { return r.id; });
}
function addUnique(list, items) {
  (items || []).forEach(function (m) { if (list.indexOf(m) < 0) list.push(m); });
}
export { reconcile } from "./reconcile.js";

export async function fetchListings(profiles, hubs, opts, filters, onProgress) {
  const hubList = Array.isArray(hubs) ? hubs : [];
  const report = typeof onProgress === "function" ? onProgress : function () {};
  // Per-location searches run one request per hub, so a big multi-location sync
  // (profiles × hubs × car_types × pages) doesn't pile into a single serverless
  // invocation and blow Vercel's function timeout (the HTTP 504). A slow/failed
  // hub is isolated: its error is recorded and the rest still return. `report`
  // fires after each location so the UI can show progress + surface results as
  // they arrive. Mock and single-hub searches keep the original single request.
  if ((opts && opts.mock) || hubList.length <= 1) {
    const r = await fetchChunk(profiles, hubList, opts, filters);
    report({ done: 1, total: 1, listings: r.listings || [] });
    return r;
  }
  // Nationwide first: one search for every profile across all locations, kept to
  // their radii by dealer coordinates — 1–10 calls instead of one+ per location.
  // Whatever it can't cover (too many matches nationally, or a location without
  // coordinates) comes back as `localProfiles` and runs per location below.
  const seen = {}; // vin -> listing, keeping the lowest price across hubs
  const errors = [];
  const notices = []; // key failover etc. — reported once, not as errors
  // Keys known spent (from the stored quota, then from each location's response),
  // so later locations start on a live key instead of each re-hitting a spent one.
  const spent = ((filters && filters.spentKeys) || []).slice();
  let keyQuotas = []; // per-key monthly quota as reported by MarketCheck
  let calls = 0;      // HTTP requests this sync actually spent
  let apiInfo = null; // MarketCheck API version / deprecation headers (latest seen)
  let fingerprints = {}, unchanged = [], queries = 0; // unchanged-search short-circuit
  let formatSuspect = false;
  let mock = false;
  let rateLimited = false;
  let rateLimitInfo = null;
  let quota = null; // lowest remaining across hubs
  let rest = profiles || [];
  let steps = [{ hubs: hubList, national: true }];
  let total = 1;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hub = step.hubs[0];
    try {
      const r = await fetchChunk(rest, step.hubs, opts, Object.assign({}, filters, { spentKeys: spent, national: step.national ? "only" : undefined }));
      if (step.national) {
        const left = {};
        (r.localProfiles || []).forEach(function (id) { left[id] = true; });
        rest = rest.filter(function (p) { return left[p.id]; });
        if (rest.length) { steps = steps.concat(hubList.map(function (h) { return { hubs: [h] }; })); total = 1 + hubList.length; }
      }
      (r.listings || []).forEach(function (l) {
        if (!l.vin) return;
        const prev = seen[l.vin];
        // Lowest REAL price wins — a priced row always beats an unpriced one.
        if (!prev || (l.price && (!prev.price || l.price < prev.price))) seen[l.vin] = l;
      });
      (r.errors || []).forEach(function (m) { errors.push(m); });
      addUnique(notices, r.notices);
      addUnique(spent, spentIn(r.keyQuotas));
      keyQuotas = mergeReports(keyQuotas, r.keyQuotas);
      calls += r.calls || 0;
      if (r.apiInfo) apiInfo = r.apiInfo;
      Object.assign(fingerprints, r.fingerprints || {});
      unchanged = unchanged.concat(r.unchanged || []);
      queries += r.queries || 0;
      if (r.formatSuspect) formatSuspect = true;
      if (r.mock) mock = true;
      if (r.rateLimited) { rateLimited = true; if (r.rateLimitInfo) rateLimitInfo = r.rateLimitInfo; }
      if (r.quota && r.quota.remaining != null && (quota == null || r.quota.remaining < quota.remaining)) quota = r.quota;
    } catch (e) {
      errors.push((step.national ? "nationwide search" : (hub.n || hub.z || "location")) + ": " + (e && e.message ? e.message : "sync failed"));
      if (e && e.rateLimited) rateLimited = true;
      // The nationwide request failed outright: fall back to every location.
      if (step.national && !rateLimited) { steps = steps.concat(hubList.map(function (h) { return { hubs: [h] }; })); total = 1 + hubList.length; }
    }
    report({ done: i + 1, total: total, listings: Object.values(seen) });
    // Quota hit: further locations will fail too, so stop rather than burn more.
    if (rateLimited) break;
  }
  return { listings: Object.values(seen), errors: errors, notices: notices, mock: mock, rateLimited: rateLimited, rateLimitInfo: rateLimitInfo, quota: quota, keyQuotas: keyQuotas, calls: calls, apiInfo: apiInfo, formatSuspect: formatSuspect, fingerprints: fingerprints, unchanged: unchanged, queries: queries };
}

// One /api/marketcheck request for the given hubs (usually a single hub).
async function fetchChunk(profiles, hubs, opts, filters) {
  const qs = opts && opts.mock ? "?mock=1" : "";
  const { data: sess } = await supabase.auth.getSession();
  const token = sess && sess.session ? sess.session.access_token : "";
  const res = await fetch("/api/marketcheck" + qs, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? "Bearer " + token : "",
    },
    body: JSON.stringify({
      profiles: (profiles || []).map(function (p) {
        return { id: p.id, name: p.name, params: p.params };
      }),
      hubs: hubs || [],
      franchiseOnly: !!(filters && filters.franchiseOnly),
      marketcheckKeys: (filters && Array.isArray(filters.marketcheckKeys)) ? filters.marketcheckKeys : [],
      fingerprints: (filters && filters.fingerprints) || {},
      national: (filters && filters.national) || undefined,
      spentKeys: (filters && Array.isArray(filters.spentKeys)) ? filters.spentKeys : [],
    }),
  });
  if (!res.ok) {
    const limited = res.status === 429 || res.status === 503 || res.status === 402;
    let msg = limited
      ? "MarketCheck rate limit / free-tier quota reached (HTTP " + res.status + ") — wait a bit and sync again."
      : "Sync failed (HTTP " + res.status + ")";
    try {
      const j = await res.json();
      if (j && j.error && !limited) msg = j.error;
    } catch (e) { /* keep default */ }
    const err = new Error(msg);
    if (limited) err.rateLimited = true;
    throw err;
  }
  const json = await res.json();
  return { listings: json.listings || [], errors: json.errors || [], notices: json.notices || [], mock: !!json.mock, rateLimited: !!json.rateLimited, rateLimitInfo: json.rateLimitInfo || null, quota: json.quota || null, keyQuotas: json.keyQuotas || [], calls: json.calls || 0, apiInfo: json.apiInfo || null, formatSuspect: !!json.formatSuspect, fingerprints: json.fingerprints || {}, unchanged: json.unchanged || [], queries: json.queries || 0, localProfiles: Array.isArray(json.localProfiles) ? json.localProfiles : (profiles || []).map(function (p) { return p.id; }) };
}

// Live-market comp broadening for the Price Check tool: fire a one-off
// MarketCheck search for a specific vehicle and return normalized listings to
// fold into the local comp pool. Separate from fetchListings (which reconciles
// against tracked inventory) — this is a read-only, on-demand widen.
export async function fetchPriceComps(query, hubs, marketcheckKeys, spentKeys) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess && sess.session ? sess.session.access_token : "";
  const res = await fetch("/api/pricecomps", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? "Bearer " + token : "",
    },
    body: JSON.stringify({
      query: query || {},
      hubs: Array.isArray(hubs) ? hubs : [],
      marketcheckKeys: Array.isArray(marketcheckKeys) ? marketcheckKeys : [],
      spentKeys: Array.isArray(spentKeys) ? spentKeys : [],
    }),
  });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    const limited = res.status === 429 || res.status === 503 || res.status === 402;
    let msg = limited
      ? "MarketCheck rate limit / quota reached — try again after it resets."
      : (j && j.message) || (j && j.error) || ("Live market check failed (HTTP " + res.status + ")");
    const err = new Error(msg);
    if (limited) err.rateLimited = true;
    if (j && j.error) err.code = j.error;
    throw err;
  }
  return { listings: j.listings || [], errors: j.errors || [], rateLimited: !!j.rateLimited, rateLimitInfo: j.rateLimitInfo || null, quota: j.quota || null, keyQuotas: j.keyQuotas || [], calls: j.calls || 0, apiInfo: j.apiInfo || null, formatSuspect: !!j.formatSuspect };
}

// Debug helper: POST /api/marketcheck?raw=1 and return the raw MarketCheck
// response + normalized sample. Wired to window.__rawSync for console use.
export async function fetchRawSample(profiles, hubs, vin, marketcheckKeys) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess && sess.session ? sess.session.access_token : "";
  const res = await fetch("/api/marketcheck?raw=1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? "Bearer " + token : "",
    },
    body: JSON.stringify({
      profiles: (profiles || []).map(function (p) { return { id: p.id, name: p.name, params: p.params }; }),
      hubs: hubs || [],
      vin: vin || undefined,
      marketcheckKeys: Array.isArray(marketcheckKeys) ? marketcheckKeys : [],
    }),
  });
  return res.json();
}

