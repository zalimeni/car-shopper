// Client-side sync (sync-on-open + "Sync now").
//
// Pulls dealer inventory via the /api/marketcheck proxy and reconciles it
// against the stored listings. Runs in the browser under the user's Supabase
// session, so every write goes through normal RLS — no service-role key.
//
// Split of responsibilities:
//   - fetchListings(): talk to the proxy, return normalized listings.
//   - reconcile():     pure function. Known VINs get price-change + last-seen
//                      updates; brand-new VINs come back as `candidates` for the
//                      existing human-approval queue. Non-destructive: a listing
//                      that vanishes from results is only flagged, never deleted
//                      or auto-rejected (auto-sold is a documented follow-up).

import { supabase } from "./supabaseClient";

export async function fetchListings(profiles, hubs, opts) {
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

export function reconcile(existing, fetched, todayStr) {
  const byVin = {};
  (fetched || []).forEach(function (f) {
    const k = vinKey(f.vin);
    if (!k) return;
    const prev = byVin[k];
    if (!prev || (f.price && f.price < prev.price)) byVin[k] = f;
  });

  const matched = {};
  const summary = { fetched: (fetched || []).length, priceUpdates: 0, refreshed: 0, newCount: 0, notSeen: 0 };

  const listings = (existing || []).map(function (l) {
    // Match on a normalized VIN (case/whitespace-insensitive) so a stored
    // listing isn't mistaken for "gone" over a trivial formatting difference.
    const k = vinKey(l.vin);
    const f = k ? byVin[k] : null;
    if (!f) {
      // A previously-synced listing that's missing this run — flag only.
      if (l.source === "marketcheck" && l.status === "watch" && l.lastSeen && l.lastSeen !== todayStr) {
        summary.notSeen++;
      }
      return l;
    }
    matched[k] = true;
    const next = Object.assign({}, l, { lastSeen: todayStr, lastChecked: todayStr });
    if (f.price && f.price !== l.price) {
      const dir = f.price < l.price ? "↓" : "↑";
      next.notes = appendNote(l.notes, dir + " Price $" + (l.price || 0).toLocaleString() + " → $" + f.price.toLocaleString() + " (" + todayStr + ")");
      // Material change: surface for review (separate from the saved watchlist)
      // and eligible for an auto re-score.
      next.reviewPending = true;
      next.lastChange = { type: "price", from: l.price || 0, to: f.price, dir: dir, at: todayStr };
      next.price = f.price;
      summary.priceUpdates++;
    } else {
      summary.refreshed++;
    }
    return next;
  });

  const candidates = [];
  Object.keys(byVin).forEach(function (vin) {
    if (matched[vin]) return;
    const f = byVin[vin];
    candidates.push(Object.assign({}, f, {
      addedDate: todayStr,
      lastChecked: todayStr,
      lastSeen: todayStr,
      status: "watch",
      scores: {},
      dealRating: "",
      notes: f.dom != null ? f.dom + " days on market" : "",
    }));
    summary.newCount++;
  });

  return { listings: listings, candidates: candidates, summary: summary };
}

// Normalize a VIN for matching: VINs are uppercase alphanumeric, so trim and
// upcase both sides before comparing (fetched vs stored).
function vinKey(v) { return String(v || "").trim().toUpperCase(); }

function appendNote(existing, note) {
  const e = (existing || "").trim();
  if (!e) return note;
  if (e.indexOf(note) > -1) return e; // idempotent across re-syncs in one day
  return e + " · " + note;
}
