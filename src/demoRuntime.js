// Demo mode — the runtime side (see src/demo.js for the pure parts).
//
// `/?demo` opens the app with no sign-in over the snapshot the owner published
// (public.demo_snapshot, one row, readable by anyone — RLS select-only).
// Everything happens in this tab: storage.js keeps edits in memory (gone on
// reload), ↻ Sync is simulated from the snapshot's held-back pool, and every
// /api call is answered locally with "not in the demo" — no MarketCheck or
// Anthropic call can leave the browser.

import { supabase } from "./supabaseClient";
import { isDemoUrl, prepareDemo, simulateSync, scoreFieldsOf } from "./demo.js";

export var DEMO = typeof window !== "undefined" && isDemoUrl(window.location.search);
export var DEMO_TABLE = "demo_snapshot";

var loaded = null; // Promise<{ data, pool } | null>
var round = 0;

// Fetch + prepare the published snapshot once per page load.
export function loadDemo() {
  if (!loaded) {
    loaded = Promise.resolve().then(function () { return supabase.from(DEMO_TABLE).select("data").eq("id", 1).maybeSingle(); })
      .then(function (r) { return r.error || !r.data ? null : prepareDemo(r.data.data, new Date()); })
      .catch(function () { return null; });
  }
  return loaded;
}

// Is there a demo to offer? (sign-in screen link)
export function demoAvailable() {
  return Promise.resolve().then(function () { return supabase.from(DEMO_TABLE).select("id").eq("id", 1).maybeSingle(); })
    .then(function (r) { return !r.error && !!r.data; })
    .catch(function () { return false; });
}

// A demo ↻ Sync, in fetchListings' result shape. `scores` keeps the released
// cars' AI scores by VIN (reconcile resets a new candidate's).
export async function demoFetchListings(listings) {
  var d = await loadDemo();
  var s = simulateSync(listings, d ? d.pool : [], round++);
  var scores = {};
  s.released.forEach(function (c) { scores[c.vin] = scoreFieldsOf(c); });
  return { listings: s.listings, goneVins: s.goneVins, scores: scores, calls: 0, errors: [], notices: [], mock: false, demo: true, results: [], decoded: {} };
}

// ── Toasts ──
export var DEMO_EVENT = "cs-demo-toast";
export function demoToast(msg) {
  try { window.dispatchEvent(new CustomEvent(DEMO_EVENT, { detail: msg })); } catch (e) { /* no window */ }
}

// Answer every /api call locally. The app's own error paths then show what a
// failed call shows; the toast says why.
var BLOCKED = {
  "/api/score": "AI scoring is off in the demo — the scores you see were made with the owner's key.",
  "/api/pricecheck": "Price Check's AI read is off in the demo.",
  "/api/pricecomps": "Live comparables are off in the demo.",
  "/api/baseline": "AI baselines are off in the demo.",
  "/api/profile-suggest": "AI suggestions are off in the demo.",
  "/api/marketcheck": "Live MarketCheck searches are off in the demo — ↻ Sync is simulated.",
};
var QUIET = { "/api/me": true }; // background checks, no toast
export function installFetchGuard() {
  if (typeof window === "undefined" || window.__demoGuard) return;
  window.__demoGuard = true;
  var real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path.indexOf("/api/") !== 0) return real(input, init);
    var method = ((init && init.method) || "GET").toUpperCase();
    // Status checks on load (key present? admin?) stay silent.
    if (!QUIET[path] && method !== "GET") demoToast(BLOCKED[path] || "That's a live call — it's off in the demo.");
    return Promise.resolve(new Response(JSON.stringify({ error: "Not available in the demo" }), { status: 403, headers: { "Content-Type": "application/json" } }));
  };
}
