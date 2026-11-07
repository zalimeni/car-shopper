// Demo mode — the pure parts (tested). A public, sign-in-free tour of the app
// over a scrubbed copy of the owner's data:
//  - buildDemoSnapshot(): what "Publish demo" (footer, admins) sends — the app
//    state minus secrets, with the notes the owner chose to drop cleared, and
//    the newest queued candidates held back in a `pool` so the demo's ↻ Sync
//    has real listings (and their AI scores) to "find".
//  - prepareDemo(): on load, shift every date so the snapshot reads as fresh.
//  - simulateSync(): one demo sync — released pool cars, a couple of price
//    drops on the watchlist, and (first sync only) one car gone.
// The runtime side (loading the row, the fetch guard, the in-memory store) is
// src/demoRuntime.js; the banner / welcome / toasts are src/Demo.jsx.

export var DEMO_VERSION = 1;
export var DEMO_POOL_MAX = 9;      // queued candidates held back for demo syncs
export var RELEASE_PER_SYNC = 3;   // pool cars each demo sync "finds"
export var DROPS_PER_SYNC = 2;     // watchlist price drops each demo sync

export function isDemoUrl(search) {
  return /(^|[?&])demo(=(1|true))?(&|$)/.test(String(search || "").replace(/^\?/, ""));
}

// Settings keys that never leave the owner's account.
var SECRET_SETTINGS = ["marketcheckKeys", "mcQuota", "mcApi"];

// Sync writes "↓ Price $X → $Y (date)" into `notes`; anything else there (an
// import's notes, hand edits), every `memo` and every typed reject reason is the
// owner's own writing. ("Reviewed update" is the app's own reason for a reject
// from an Updated card, so it never needs review.)
var AUTO_NOTE = /^[↓↑] Price /;
function splitNotes(s) { return String(s || "").split(" · ").map(function (x) { return x.trim(); }).filter(Boolean); }
export function autoNotes(notes) { return splitNotes(notes).filter(function (x) { return AUTO_NOTE.test(x); }).join(" · "); }
export function userNotes(notes) { return splitNotes(notes).filter(function (x) { return !AUTO_NOTE.test(x); }).join(" · "); }
var AUTO_REASONS = { "Reviewed update": true, "No reason given": true };
export function userReason(r) { r = String(r || "").trim(); return r && !AUTO_REASONS[r] ? r : ""; }

function carsOf(data) {
  return [].concat((data && data.listings) || [], (data && data.candidates) || [], (data && data.skipped) || []);
}
function carName(l) { return [l.year, l.make, l.model, l.trim].filter(Boolean).join(" ") || l.vehicle || l.vin || "Listing"; }

// Every car with words the owner wrote, for the publish checklist.
export function reviewableNotes(data) {
  var seen = {};
  return carsOf(data).map(function (l) {
    var key = l.id || l.vin;
    if (!key || seen[key]) return null;
    seen[key] = true;
    var memo = String(l.memo || "").trim(), notes = userNotes(l.notes), reason = userReason(l.rejectReason);
    return memo || notes || reason ? { key: key, name: carName(l), memo: memo, notes: notes, reason: reason } : null;
  }).filter(Boolean);
}

function scrubCar(l, keep) {
  var o = Object.assign({}, l);
  delete o._candidate; delete o.fromScheduled;
  if (!keep[o.id || o.vin]) {
    if (o.memo) o.memo = "";
    if (o.notes) o.notes = autoNotes(o.notes);
    if (userReason(o.rejectReason)) o.rejectReason = "No reason given";
  }
  return o;
}

export function scrubSettings(s) {
  var o = Object.assign({}, s || {});
  SECRET_SETTINGS.forEach(function (k) { delete o[k]; });
  return o;
}

// opts: { keep: { [id|vin]: true } notes to keep, now: Date, poolMax }
export function buildDemoSnapshot(data, opts) {
  var o = opts || {};
  var keep = o.keep || {};
  var d = JSON.parse(JSON.stringify(data || {}));
  d.settings = scrubSettings(d.settings);
  d.autoScore = false; // no Anthropic key in the demo
  d.listings = (d.listings || []).map(function (l) { return scrubCar(l, keep); });
  d.skipped = (d.skipped || []).map(function (l) { return scrubCar(l, keep); });
  var queue = (d.candidates || []).map(function (l) { return scrubCar(l, keep); });
  // Newest first; hold back the newest (scored ones first) for the demo's syncs.
  var order = queue.map(function (c, i) { return { c: c, i: i }; }).sort(function (a, b) {
    var s = (b.c.scoredAt ? 1 : 0) - (a.c.scoredAt ? 1 : 0);
    if (s) return s;
    return String(b.c.addedDate || "").localeCompare(String(a.c.addedDate || "")) || b.i - a.i;
  });
  var max = o.poolMax != null ? o.poolMax : DEMO_POOL_MAX;
  var held = {};
  var pool = order.slice(0, max).map(function (x) { held[x.i] = true; return x.c; }).filter(function (c) { return c.vin; });
  d.candidates = queue.filter(function (c, i) { return !held[i]; });
  return { demoVersion: DEMO_VERSION, exportedAt: (o.now || new Date()).toISOString(), data: d, pool: pool };
}

// ── Dates ──
var DAY = 86400000;
var DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})(?=$|[^\d])/g;
export function shiftDateStr(s, days) {
  if (!days || typeof s !== "string" || /^https?:/i.test(s)) return s;
  return s.replace(DATE_RE, function (m, y, mo, d) {
    var t = Date.UTC(+y, +mo - 1, +d);
    if (isNaN(t) || +mo < 1 || +mo > 12 || +d < 1 || +d > 31) return m;
    return new Date(t + days * DAY).toISOString().slice(0, 10);
  });
}
export function shiftDates(v, days) {
  if (!days) return v;
  if (typeof v === "string") return shiftDateStr(v, days);
  if (Array.isArray(v)) return v.map(function (x) { return shiftDates(x, days); });
  if (v && typeof v === "object") {
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = shiftDates(v[k], days); });
    return o;
  }
  return v;
}
export function daysSince(iso, now) {
  var t = Date.parse(iso);
  if (isNaN(t)) return 0;
  var a = new Date(t), b = now || new Date();
  return Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / DAY);
}

// The snapshot as of today: { data, pool }. Missing/invalid → null.
export function prepareDemo(snap, now) {
  if (!snap || typeof snap !== "object" || !snap.data || typeof snap.data !== "object") return null;
  var days = daysSince(snap.exportedAt, now);
  var data = shiftDates(snap.data, days);
  // A demo visitor can't run the real thing: nothing scores on its own and no
  // secret slipped in by an older publish survives.
  data.settings = scrubSettings(data.settings);
  data.autoScore = false;
  return { data: data, pool: shiftDates(Array.isArray(snap.pool) ? snap.pool : [], days) };
}

// ── Sync ──
function dropPrice(p) {
  var n = Math.floor((p * 0.97) / 100) * 100;
  return p - n < 200 ? p - 200 : n;
}

// One demo sync, shaped like fetchListings' answer so reconcile() handles it.
// listings: current data.listings; pool: held-back candidates; round: 0, 1, …
// → { listings: fetched rows, goneVins, released: pool cars found this time }
export function simulateSync(listings, pool, round) {
  var r = round || 0;
  var watch = (listings || []).filter(function (l) { return l && l.vin && l.status === "watch" && !l.goneAt; })
    .sort(function (a, b) { return String(a.id || a.vin).localeCompare(String(b.id || b.vin)); });
  var priced = watch.filter(function (l) { return l.price > 1000; });
  var drop = {};
  for (var k = 0; k < Math.min(DROPS_PER_SYNC, priced.length); k++) {
    drop[priced[(r * DROPS_PER_SYNC + k) % priced.length].vin] = true;
  }
  var goneVins = [];
  if (r === 0 && watch.length >= 4) {
    var g = watch.filter(function (l) { return !drop[l.vin] && l.source === "marketcheck"; })
      .sort(function (a, b) { return (b.dom || 0) - (a.dom || 0); })[0];
    if (g) goneVins.push(g.vin);
  }
  var fetched = watch.filter(function (l) { return goneVins.indexOf(l.vin) < 0; }).map(function (l) {
    return drop[l.vin] ? Object.assign({}, l, { price: dropPrice(l.price) }) : l;
  });
  var released = (pool || []).slice(r * RELEASE_PER_SYNC, (r + 1) * RELEASE_PER_SYNC);
  return { listings: fetched.concat(released), goneVins: goneVins, released: released };
}

// AI-score fields a released pool car keeps once reconcile() has reset them.
export var SCORE_FIELDS = ["scores", "aiSummary", "aiRationales", "scoredAt", "scoreHash", "dealRating"];
export function scoreFieldsOf(c) {
  var o = {};
  SCORE_FIELDS.forEach(function (k) { if (c && c[k] != null) o[k] = c[k]; });
  return o;
}
