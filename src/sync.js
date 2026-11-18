// Client-side sync (the ↻ Sync button).
//
// Pulls dealer inventory via the /api/marketcheck proxy and reconciles it
// against the stored listings. Runs in the browser under the user's Supabase
// session, so every write goes through normal RLS — no service-role key.
//
// Split of responsibilities:
//   - fetchListings(): run the planned steps (src/syncPlan.js) through the proxy.
//   - reconcile():     pure function, lives in src/reconcile.js (shared with
//                      the server-side scheduled sync) and re-exported here.

import { authHeaders } from "./apiAuth";
import { DEMO, demoPostStep, demoPriceComps } from "./demoRuntime";
import { runSync } from "./syncPlan.js";
export { reconcile } from "./reconcile.js";

// Run a planned sync (src/syncPlan.js planSync) — one /api/marketcheck request per
// step, so no single serverless invocation nears the timeout. Keys found spent are
// carried forward so later steps start on a live key instead of each re-hitting it.
// filters: { franchiseOnly, excludeSalt, spentKeys, colorCache, alsoDecode }
// -> runSync's result: { listings, results, goneVins, errors, notices, calls, ... }
export async function fetchListings(steps, tracked, filters, onProgress) {
  const f = filters || {};
  const spent = (f.spentKeys || []).slice();
  return runSync(steps, tracked, async function (step) {
    const r = await postStep(step, Object.assign({}, f, { spentKeys: spent }));
    (r.keyQuotas || []).forEach(function (q) { if (q && q.exhausted && q.id && spent.indexOf(q.id) < 0) spent.push(q.id); });
    return r;
  }, onProgress, { colorCache: f.colorCache, alsoDecode: f.alsoDecode });
}

// One step -> the proxy's report. Throws on an HTTP failure (err.rateLimited for 429/503/402).
export async function postStep(step, filters) {
  if (DEMO) return demoPostStep(step);
  const f = filters || {};
  const p = step.profile;
  const res = await fetch("/api/marketcheck", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      kind: step.kind,
      profile: p ? { id: p.id, name: p.name, params: p.params } : undefined,
      since: step.since,
      vins: step.vins,
      excludeSalt: f.excludeSalt !== false,
      franchiseOnly: !!f.franchiseOnly,
      spentKeys: Array.isArray(f.spentKeys) ? f.spentKeys : [],
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
  return res.json();
}

// Live-market comp broadening for the Price Check tool: fire a one-off
// MarketCheck search for a specific vehicle and return normalized listings to
// fold into the local comp pool. Separate from fetchListings (which reconciles
// against tracked inventory) — this is a read-only, on-demand widen: a `local`
// step of /api/marketcheck (a radius search around one location, the home base).
export async function fetchPriceComps(query, hub, spentKeys) {
  if (DEMO) return demoPriceComps(query);
  const res = await fetch("/api/marketcheck", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      kind: "local",
      query: query || {},
      hub: hub || undefined,
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
  return { listings: j.listings || [], errors: j.errors || [], rateLimited: !!j.rateLimited, rateLimitInfo: j.rateLimitInfo || null, keyQuotas: j.keyQuotas || [], calls: j.calls || 0, apiInfo: j.apiInfo || null };
}

// Debug helper (the footer's Debug raw, window.__rawSync): POST
// /api/marketcheck?raw=1 — ONE real call: a one-page sample of `profile`'s full
// refresh (or, with a VIN, every active record MarketCheck has for it) -> the raw
// rows beside how normalize() maps them, plus the step's report (keyQuotas,
// apiInfo, calls) for the quota gauge. filters: { excludeSalt, franchiseOnly, spentKeys }
export async function fetchRawSample(profile, vin, filters) {
  const f = filters || {};
  const res = await fetch("/api/marketcheck?raw=1", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      profile: profile ? { id: profile.id, name: profile.name, params: profile.params } : undefined,
      vin: vin || undefined,
      excludeSalt: f.excludeSalt !== false,
      franchiseOnly: !!f.franchiseOnly,
      spentKeys: Array.isArray(f.spentKeys) ? f.spentKeys : [],
    }),
  });
  return res.json();
}
