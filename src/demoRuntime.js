// Demo mode — the runtime side (see src/demo.js for the pure parts).
//
// `/?demo` opens the app with no sign-in over the bundled fixture
// (public/demo/snapshot.json + thumbnails in public/demo/cars — curated by
// scripts/demo-fixture/). `/?demo=live` uses the copy the owner published from
// the app instead (public.demo_snapshot, one row, readable by anyone — RLS
// select-only); it's also the fallback if the fixture can't load.
// Everything happens in this tab: storage.js keeps edits in memory (gone on
// reload), ↻ Sync is simulated from the snapshot's held-back pool, and every
// /api call is answered locally with "not in the demo" — no MarketCheck or
// Anthropic call can leave the browser.

import { supabase } from "./supabaseClient";
import { isDemoUrl, isLiveDemoUrl, prepareDemo, simulateSync, scoreFieldsOf, demoScore, demoCount, demoMarketComps, demoPriceAssessment, demoBaseline, demoSuggestion, DEMO_KEY_ID, DEMO_QUOTA_LIMIT } from "./demo.js";
import { assess } from "./priceCheck.js";

export var DEMO = typeof window !== "undefined" && isDemoUrl(window.location.search);
export var DEMO_TABLE = "demo_snapshot";
export var DEMO_FIXTURE = "/demo/snapshot.json";
var LIVE = typeof window !== "undefined" && isLiveDemoUrl(window.location.search);

var loaded = null; // Promise<{ data, pool } | null>
var round = 0;

function liveRow() {
  return Promise.resolve().then(function () { return supabase.from(DEMO_TABLE).select("data").eq("id", 1).maybeSingle(); })
    .then(function (r) { return r.error || !r.data ? null : prepareDemo(r.data.data, new Date()); })
    .catch(function () { return null; });
}
function fixture() {
  return Promise.resolve().then(function () { return fetch(DEMO_FIXTURE, { cache: "no-cache" }); })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { return j ? prepareDemo(j, new Date()) : null; })
    .catch(function () { return null; });
}
// Load + prepare the demo data once per page load.
export function loadDemo() {
  if (!loaded) loaded = LIVE ? liveRow() : fixture().then(function (d) { return d || liveRow(); });
  return loaded;
}

// Is there a demo to offer? (sign-in screen link) The fixture ships with the app.
export function demoAvailable() {
  return Promise.resolve().then(function () { return fetch(DEMO_FIXTURE, { method: "HEAD", cache: "no-cache" }); })
    .then(function (r) { return !!(r && r.ok); })
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

// The App's live state (registered on render), so market answers use the
// visitor's in-memory edits, not just the snapshot as loaded.
var getLive = function () { return null; };
export function registerDemoData(fn) { getLive = fn; }
function live() { return getLive() || {}; }
async function allCars() {
  var l = live(), d = l.data || {}, snap = await loadDemo();
  return [].concat(d.listings || [], l.candidates || d.candidates || [], d.skipped || [], (snap && snap.pool) || []);
}
// One pretend MarketCheck call off the demo key, as a keyQuotas report.
function spendQuota(calls) {
  var d = live().data || {};
  var snap = d.settings && d.settings.mcQuota && d.settings.mcQuota.snaps && d.settings.mcQuota.snaps[DEMO_KEY_ID];
  var remaining = Math.max(0, (snap && snap.remaining != null ? snap.remaining : DEMO_QUOTA_LIMIT) - calls);
  return [{ id: DEMO_KEY_ID, remaining: remaining, limit: (snap && snap.limit) || DEMO_QUOTA_LIMIT, reset: snap && snap.reset, exhausted: remaining <= 0 }];
}

// postStep (src/sync.js) in the demo: a `count` (wizard Explore, profile save)
// answered from the demo's cars and the owner's stored breakdowns.
export async function demoPostStep(step) {
  await pause(600, 1200);
  if (!step || step.kind !== "count") return { listings: [], errors: [], notices: [], keyQuotas: spendQuota(1), calls: 1 };
  var d = live().data || {};
  var r = demoCount(step.profile, await allCars(), d.profiles, d.settings && d.settings.mcProfiles);
  if (!r.numFound) demoToast("The demo only knows the cars already in it — try a make and model from its profiles.");
  return Object.assign(r, { keyQuotas: spendQuota(1), calls: 1 });
}

// Price Check's live-market button: a few simulated listings near the demo's own.
export async function demoPriceComps(query) {
  await pause(900, 1600);
  return { listings: demoMarketComps(query, await allCars(), 6), errors: [], rateLimited: false, rateLimitInfo: null, quota: null, keyQuotas: spendQuota(1), calls: 1, apiInfo: null, formatSuspect: false };
}

// The three one-shot AI answers, written locally.
export async function demoPriceRead(query, comps, stats, confidence) {
  await pause(1200, 2200);
  var verdict = query && query.askingPrice && stats ? assess(query.askingPrice, stats, (comps || []).map(function (c) { return c.price; })) : null;
  return demoPriceAssessment(query, { stats: stats, verdict: verdict, confidence: confidence });
}
export async function demoBaselineFor(profile, listings) {
  await pause(1500, 2500);
  var p = (profile && profile.params) || {};
  var v = [p.make, p.model].filter(Boolean).join(" ");
  return demoBaseline(profile, (listings || []).map(function (l, i) { return Object.assign({ vehicle: v, vin: "B" + i }, l); }));
}
export async function demoSuggest(profile, market) {
  await pause(1500, 2500);
  return demoSuggestion(profile, market, (live().data || {}).profiles);
}
// The scoring prompt the server would send (Criteria's prompt editor).
export async function demoScorePrompt() {
  var m = await import("../api/_scoring.js");
  return { system: m.SCORE_SYSTEM, guidance: m.CRITERION_GUIDANCE };
}

// ── Toasts ──
export var DEMO_EVENT = "cs-demo-toast";
export function demoToast(msg) {
  try { window.dispatchEvent(new CustomEvent(DEMO_EVENT, { detail: msg })); } catch (e) { /* no window */ }
}

// Answer every /api call locally. The app's own error paths then show what a
// failed call shows; the toast says why.
var BLOCKED = {
  "/api/ai": "AI calls are simulated in the demo — no real request is made.",
  "/api/anthropic-key": "The demo's AI key is simulated — keys can't be changed.",
  "/api/pricecomps": "Live comparables are off in the demo.",
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
