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

import { supabase } from "./supabaseClient";
import { runSync } from "./syncPlan.js";
export { reconcile } from "./reconcile.js";

// Run a planned sync (src/syncPlan.js planSync) — one /api/marketcheck request per
// step, so no single serverless invocation nears the timeout. Keys found spent are
// carried forward so later steps start on a live key instead of each re-hitting it.
// filters: { franchiseOnly, excludeSalt, marketcheckKeys, spentKeys, colorCache }
// -> runSync's result: { listings, results, goneVins, errors, notices, calls, ... }
export async function fetchListings(steps, tracked, opts, filters, onProgress) {
  const f = filters || {};
  const spent = (f.spentKeys || []).slice();
  return runSync(steps, tracked, async function (step) {
    const r = await postStep(step, opts, Object.assign({}, f, { spentKeys: spent }));
    (r.keyQuotas || []).forEach(function (q) { if (q && q.exhausted && q.id && spent.indexOf(q.id) < 0) spent.push(q.id); });
    return r;
  }, onProgress, { colorCache: f.colorCache });
}

// One step -> the proxy's report. Throws on an HTTP failure (err.rateLimited for 429/503/402).
export async function postStep(step, opts, filters) {
  const f = filters || {};
  const qs = opts && opts.mock ? "?mock=1" : "";
  const { data: sess } = await supabase.auth.getSession();
  const token = sess && sess.session ? sess.session.access_token : "";
  const p = step.profile;
  const res = await fetch("/api/marketcheck" + qs, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" },
    body: JSON.stringify({
      kind: step.kind,
      profile: p ? { id: p.id, name: p.name, params: p.params } : undefined,
      since: step.since,
      vins: step.vins,
      excludeSalt: f.excludeSalt !== false,
      franchiseOnly: !!f.franchiseOnly,
      marketcheckKeys: Array.isArray(f.marketcheckKeys) ? f.marketcheckKeys : [],
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
export async function fetchRawSample(profiles, hubs, vin, marketcheckKeys) { // hubs: [] = nationwide
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

