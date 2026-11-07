// Demo mode — the runtime side (see src/demo.js for the pure parts).
//
// `/?demo` opens the app with no sign-in over the snapshot the owner published
// (public.demo_snapshot, one row, readable by anyone — RLS select-only).
// Everything happens in this tab: storage.js keeps edits in memory (gone on
// reload), ↻ Sync is simulated from the snapshot's held-back pool, and every
// /api call is answered locally with "not in the demo" — no MarketCheck or
// Anthropic call can leave the browser.

import { supabase } from "./supabaseClient";
import { isDemoUrl, prepareDemo, simulateSync, scoreFieldsOf, demoScore, DEMO_KEY_ID, DEMO_QUOTA_LIMIT } from "./demo.js";

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

// Pretend network time, so sync and scoring feel like the real thing.
// Scaled to 0 by tests.
var delayScale = 1;
export function setDemoDelay(scale) { delayScale = scale; }
function pause(min, max) {
  var ms = (min + Math.random() * (max - min)) * delayScale;
  return ms > 0 ? new Promise(function (r) { setTimeout(r, ms); }) : Promise.resolve();
}

// A demo ↻ Sync, in fetchListings' result shape: one paced "search" per step
// (progress like the real one), then the watchlist VIN lookup. `scores` keeps
// the released cars' AI scores by VIN (reconcile resets a new candidate's).
// The demo key's quota goes down by the calls a real sync would have made.
export async function demoFetchListings(listings, steps, onProgress, quota) {
  var d = await loadDemo();
  var s = simulateSync(listings, d ? d.pool : [], round++);
  var list = steps && steps.length ? steps : [{ profile: { name: "Search" } }];
  var found = [], shown = {};
  for (var i = 0; i < list.length; i++) {
    await pause(700, 1400);
    var pid = list[i].profile && list[i].profile.id;
    var last = i === list.length - 1;
    // Each search "returns" its profile's cars; the last one sweeps up the rest.
    var add = s.listings.filter(function (l) { return !shown[l.vin] && (last || l.profileId === pid); });
    add.forEach(function (l) { shown[l.vin] = true; });
    found = found.concat(add);
    if (onProgress) onProgress({ done: i + 1, total: list.length, label: list[i].profile && list[i].profile.name, listings: found.slice() });
  }
  await pause(400, 800); // watchlist VIN lookup
  var scores = {};
  s.released.forEach(function (c) { scores[c.vin] = scoreFieldsOf(c); });
  var calls = list.length + (s.goneVins.length ? 1 : 0);
  var snap = quota && quota.snaps && quota.snaps[DEMO_KEY_ID];
  var remaining = Math.max(0, (snap && snap.remaining != null ? snap.remaining : DEMO_QUOTA_LIMIT) - calls);
  return { listings: s.listings, goneVins: s.goneVins, scores: scores, calls: calls, errors: [], notices: [], mock: false, demo: true, results: [], decoded: {},
    keyQuotas: [{ id: DEMO_KEY_ID, remaining: remaining, limit: (snap && snap.limit) || DEMO_QUOTA_LIMIT, reset: snap && snap.reset, exhausted: remaining <= 0 }] };
}

// Demo scoring: scoreSet's contract (progressive onPairs / onProgress), paced
// like a few Anthropic calls, each car scored by demoScore() from the
// already-scored cars in ctx.demoRefs.
export async function demoScoreSet(items, ctx, opts) {
  var o = opts || {};
  var all = [];
  for (var i = 0; i < items.length; i += 5) {
    await pause(1100, 2200);
    var pairs = items.slice(i, i + 5).map(function (it) { return { item: it, result: demoScore(it, ctx.demoRefs || [], ctx.criteria) }; });
    all = all.concat(pairs);
    if (o.onPairs) o.onPairs(pairs);
    if (o.onProgress) o.onProgress(Math.min(i + 5, items.length), items.length);
  }
  return all;
}

// ── Toasts ──
export var DEMO_EVENT = "cs-demo-toast";
export function demoToast(msg) {
  try { window.dispatchEvent(new CustomEvent(DEMO_EVENT, { detail: msg })); } catch (e) { /* no window */ }
}

// Answer every /api call locally. The app's own error paths then show what a
// failed call shows; the toast says why.
var BLOCKED = {
  "/api/score": "Demo scores are simulated — no AI call.",
  "/api/anthropic-key": "The demo's AI key is simulated — keys can't be changed.",
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
