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
export { reconcile } from "./reconcile.js";

export async function fetchListings(profiles, hubs, opts, filters, onProgress) {
  const hubList = Array.isArray(hubs) ? hubs : [];
  const report = typeof onProgress === "function" ? onProgress : function () {};
  // Split the search PER HUB, one request each, so a big multi-location sync
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
  const seen = {}; // vin -> listing, keeping the lowest price across hubs
  const errors = [];
  let mock = false;
  for (let i = 0; i < hubList.length; i++) {
    const hub = hubList[i];
    try {
      const r = await fetchChunk(profiles, [hub], opts, filters);
      (r.listings || []).forEach(function (l) {
        if (!l.vin) return;
        const prev = seen[l.vin];
        // Lowest REAL price wins — a priced row always beats an unpriced one.
        if (!prev || (l.price && (!prev.price || l.price < prev.price))) seen[l.vin] = l;
      });
      (r.errors || []).forEach(function (m) { errors.push(m); });
      if (r.mock) mock = true;
    } catch (e) {
      errors.push((hub.n || hub.z || "location") + ": " + (e && e.message ? e.message : "sync failed"));
    }
    report({ done: i + 1, total: hubList.length, listings: Object.values(seen) });
  }
  return { listings: Object.values(seen), errors: errors, mock: mock };
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
    }),
  });
  if (!res.ok) {
    let msg = "Sync failed (HTTP " + res.status + ")";
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  const json = await res.json();
  return { listings: json.listings || [], errors: json.errors || [], mock: !!json.mock };
}

// Debug helper: POST /api/marketcheck?raw=1 and return the raw MarketCheck
// response + normalized sample. Wired to window.__rawSync for console use.
export async function fetchRawSample(profiles, hubs) {
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
    }),
  });
  return res.json();
}

