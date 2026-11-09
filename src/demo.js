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
  return /(^|[?&])demo(=(1|true|live))?(&|$)/.test(String(search || "").replace(/^\?/, ""));
}
// `?demo=live`: the copy the owner published (Supabase) instead of the bundled fixture.
export function isLiveDemoUrl(search) { return /(^|[?&])demo=live(&|$)/.test(String(search || "").replace(/^\?/, "")); }

// Settings keys that never leave the owner's account.
var SECRET_SETTINGS = ["marketcheckKeys", "mcQuota", "mcApi"];

// Sync writes "↓ Price $X → $Y (date)" into `notes`; anything else there (an
// import's notes, hand edits) and every `memo` is the owner's own writing.
var AUTO_NOTE = /^[↓↑] Price /;
function splitNotes(s) { return String(s || "").split(" · ").map(function (x) { return x.trim(); }).filter(Boolean); }
export function autoNotes(notes) { return splitNotes(notes).filter(function (x) { return AUTO_NOTE.test(x); }).join(" · "); }
export function userNotes(notes) { return splitNotes(notes).filter(function (x) { return !AUTO_NOTE.test(x); }).join(" · "); }

function carsOf(data) {
  return [].concat((data && data.listings) || [], (data && data.candidates) || [], (data && data.skipped) || []);
}
function carName(l) {
  var v = l.make || l.model ? [l.make, l.model].filter(Boolean).join(" ") : l.vehicle;
  return [l.year, v, l.trim].filter(Boolean).join(" ") || l.vin || "Listing";
}
// Listings store mileage as `mileage` (older/hand-made ones may say `miles`).
function milesOf(l) { return l && l.mileage != null ? +l.mileage : l && l.miles != null ? +l.miles : null; }

// Every car with words the owner wrote, for the publish checklist.
export function reviewableNotes(data) {
  var seen = {};
  return carsOf(data).map(function (l) {
    var key = l.id || l.vin;
    if (!key || seen[key]) return null;
    seen[key] = true;
    var memo = String(l.memo || "").trim(), notes = userNotes(l.notes);
    return memo || notes ? { key: key, name: carName(l), memo: memo, notes: notes } : null;
  }).filter(Boolean);
}

function scrubCar(l, keep) {
  var o = Object.assign({}, l);
  delete o._candidate; delete o.fromScheduled;
  if (!keep[o.id || o.vin]) {
    if (o.memo) o.memo = "";
    if (o.notes) o.notes = autoNotes(o.notes);
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
  // No secret slipped in by an older publish survives; in their place a demo
  // key with a made-up quota, so the gauge and quota modal have something to show.
  // Auto-score is on: demo scoring is simulated (demoScore), no AI call.
  data.settings = Object.assign(scrubSettings(data.settings), {
    marketcheckKeys: [{ key: DEMO_KEY, label: "Demo key" }],
    mcQuota: demoQuota(now || new Date(), data.lastSynced),
  });
  data.autoScore = true;
  // Show off the daily background sync: the two newest queued cars greet the
  // visitor as "found by the background sync".
  var q = Array.isArray(data.candidates) ? data.candidates.slice() : [];
  q.map(function (c, i) { return { c: c, i: i }; })
    .sort(function (a, b) { return String(b.c.addedDate || "").localeCompare(String(a.c.addedDate || "")) || b.i - a.i; })
    .slice(0, 2).forEach(function (x) { q[x.i] = Object.assign({}, x.c, { fromScheduled: true }); });
  data.candidates = q;
  return { data: data, pool: shiftDates(Array.isArray(snap.pool) ? snap.pool : [], days) };
}

// ── MarketCheck quota (made up; the real key never leaves the owner's account) ──
export var DEMO_KEY = "demo-key-DEMO";
export var DEMO_KEY_ID = "DEMO";
export var DEMO_QUOTA_LIMIT = 500;
export var DEMO_QUOTA_USED = 118;
export function demoQuota(now, lastSynced) {
  var n = now || new Date();
  var reset = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)).toISOString();
  var at = lastSynced || n.toISOString();
  return {
    snaps: (function () { var o = {}; o[DEMO_KEY_ID] = { remaining: DEMO_QUOTA_LIMIT - DEMO_QUOTA_USED, limit: DEMO_QUOTA_LIMIT, reset: reset, exhausted: false, at: at }; return o; })(),
    lastSync: { calls: 9, at: at, full: 3, searches: 3 },
  };
}

// ── Scoring (simulated) ──
// A demo score copies the closest already-scored car's scores — same profile
// first, then trim, year, price, miles — and nudges price / mileage by how this
// car compares. Rationales say so. Never an AI call.
function carDist(a, b) {
  return (a.profileId === b.profileId ? 0 : 100)
    + (String(a.trim || "").toLowerCase() === String(b.trim || "").toLowerCase() ? 0 : 3)
    + Math.abs((+a.year || 0) - (+b.year || 0)) * 2
    + Math.abs((+a.price || 0) - (+b.price || 0)) / 1500
    + Math.abs((milesOf(a) || 0) - (milesOf(b) || 0)) / 15000;
}
function clampScore(n) { return Math.max(1, Math.min(10, Math.round(n))); }
function money(n) { return "$" + Math.round(n || 0).toLocaleString("en-US"); }
function milesStr(n) { return Math.round(n || 0).toLocaleString("en-US") + " mi"; }
export function demoScore(item, refs, criteria) {
  var key = item && (item.id || item.vin);
  var pool = (refs || []).filter(function (r) { return r && r.scoredAt && r.scores && Object.keys(r.scores).length && (r.id || r.vin) !== key; });
  var ref = pool.slice().sort(function (a, b) { return carDist(item, a) - carDist(item, b); })[0];
  var scores = {}, rationales = {};
  var like = ref ? "a similar " + carName(ref) + (ref.price ? " at " + money(ref.price) : "") : "";
  (criteria || []).forEach(function (c) {
    var base = ref && ref.scores[c.id] != null ? ref.scores[c.id] : 5;
    var s = base, why = ref ? "Same as " + like + "." : "No scored car to compare with — middle score.";
    if (ref && c.id === "price" && item.price && ref.price) {
      s = base + (ref.price - item.price) / 1500;
      why = money(item.price) + " vs " + money(ref.price) + " on " + like.replace(/ at \$[\d,]+$/, "") + ".";
    } else if (ref && c.id === "mileage" && milesOf(item) != null && milesOf(ref) != null) {
      s = base + (milesOf(ref) - milesOf(item)) / 12000;
      why = milesStr(milesOf(item)) + " vs " + milesStr(milesOf(ref)) + " on " + like.replace(/ at \$[\d,]+$/, "") + ".";
    }
    scores[c.id] = clampScore(s);
    rationales[c.id] = "Demo estimate: " + why;
  });
  return {
    ok: true, scores: scores, rationales: rationales,
    summary: "Demo score — no AI call. " + (ref ? "Modeled on " + like + ", adjusted for price and mileage." : "Nothing scored yet to model it on."),
  };
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

// ── Market answers from the demo's own cars (no MarketCheck) ──

// l.vehicle is "Make Model" on synced cars; hand-made ones may carry make/model.
export function sameModel(l, make, model) {
  var v = (String(l.vehicle || "") + " " + String(l.make || "") + " " + String(l.model || "")).toLowerCase();
  var mk = String(make || "").toLowerCase().trim(), md = String(model || "").toLowerCase().trim();
  if (!mk && !md) return false;
  return (!mk || v.indexOf(mk) > -1) && (!md || v.indexOf(md) > -1);
}
function yearSet(s) {
  var out = {};
  String(s || "").split(",").forEach(function (t) {
    var m = t.trim().match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (m) { for (var y = Math.min(+m[1], +m[2]); y <= Math.max(+m[1], +m[2]); y++) out[y] = true; }
    else if (/^\d{4}$/.test(t.trim())) out[+t.trim()] = true;
  });
  return Object.keys(out).length ? out : null;
}
function uniqCars(cars) {
  var seen = {};
  return (cars || []).filter(function (l) { var k = l && (l.vin || l.id); if (!k || seen[k]) return false; seen[k] = true; return true; });
}
function countBy(cars, f) {
  var counts = {}, listed = 0;
  cars.forEach(function (l) { var v = f(l); if (v) { counts[v] = (counts[v] || 0) + 1; listed++; } });
  return Object.keys(counts).length ? { counts: counts, unlisted: cars.length - listed } : null;
}
function pct(xs, p) {
  if (!xs.length) return null;
  var i = (xs.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}
export function statsOf(values) {
  var xs = values.filter(function (v) { return v != null && v > 0; }).sort(function (a, b) { return a - b; });
  if (!xs.length) return null;
  var pc = {};
  [5, 25, 50, 75, 90, 95, 99].forEach(function (p) { pc[p.toFixed(1)] = Math.round(pct(xs, p / 100)); });
  return { min: xs[0], max: xs[xs.length - 1], mean: Math.round(xs.reduce(function (a, b) { return a + b; }, 0) / xs.length),
    median: Math.round(pct(xs, 0.5)), count: xs.length, missing: 0, percentiles: pc };
}

// A `count` step's answer (facets + price/mileage stats) for a profile, from the
// demo's cars of that make/model. Where a profile of the same make/model has
// nationwide breakdowns stored from the owner's syncs (settings.mcProfiles),
// those win and set the total; years and stats always come from the cars.
export function demoCount(profile, cars, profiles, mcProfiles) {
  var p = (profile && profile.params) || {};
  var ys = yearSet(p.years);
  var mine = uniqCars(cars).filter(function (l) { return sameModel(l, p.make, p.model) && (!ys || ys[l.year]); });
  var twin = (profiles || []).find(function (x) { return x && x.params && mcProfiles && mcProfiles[x.id] && sameModel({ vehicle: (x.params.make || "") + " " + (x.params.model || "") }, p.make, p.model); });
  var stored = twin ? mcProfiles[twin.id] : null;
  var strip = function (f) { if (!f || !f.counts) return null; var o = { counts: f.counts, unlisted: f.unlisted != null ? f.unlisted : null }; return o; };
  var r = {
    kind: "count", ok: true, demo: true,
    numFound: stored && stored.count != null ? Math.max(stored.count, mine.length) : mine.length,
    colors: (stored && strip(stored.colors)) || countBy(mine, function (l) { return l.baseColor; }),
    trims: (stored && strip(stored.trims)) || countBy(mine, function (l) { return l.trim; }),
    drivetrains: (stored && strip(stored.drivetrains)) || countBy(mine, function (l) { return l.drivetrain; }),
    years: countBy(mine, function (l) { return l.year ? String(l.year) : ""; }),
    stats: mine.length ? { price: statsOf(mine.map(function (l) { return +l.price || 0; })), miles: statsOf(mine.map(milesOf)) } : null,
    listings: [], errors: [], notices: [],
  };
  return r;
}

// Price Check's "live market": a handful of made-up listings around the demo's
// own cars of that make/model (prices ±7%, miles ±20%), clearly not real.
export function demoMarketComps(query, cars, n) {
  var q = query || {};
  var base = uniqCars(cars).filter(function (l) { return sameModel(l, q.make, q.model) && l.price > 0 && (!q.year || !l.year || Math.abs(l.year - q.year) <= 1); });
  if (!base.length) return [];
  var out = [], count = n || 6;
  for (var i = 0; i < count; i++) {
    var b = base[i % base.length];
    var wobble = function (k, amp) { var x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453; return 1 + (x - Math.floor(x) - 0.5) * 2 * amp; };
    out.push({
      vin: "DEMOCOMP" + String(i + 1).padStart(9, "0"), vehicle: b.vehicle || [b.make, b.model].filter(Boolean).join(" "), year: b.year, trim: b.trim || "",
      price: Math.round((b.price * wobble(1, 0.07)) / 100) * 100, mileage: Math.round(((milesOf(b) || 40000) * wobble(2, 0.2)) / 500) * 500,
      dealer: "Simulated market listing", dealerType: b.dealerType || "", state: b.state || "", source: "demo",
    });
  }
  return out;
}

function m0(n) { return "$" + Math.round(n || 0).toLocaleString("en-US"); }

// Price Check's AI read, written from the comp numbers.
export function demoPriceAssessment(query, result) {
  var q = query || {}, st = result && result.stats, v = result && result.verdict;
  if (!st) return "Demo read (no AI call): not enough comparable cars here to say.";
  var name = [q.year, q.make, q.model, q.trim].filter(Boolean).join(" ") || "this car";
  var parts = ["Demo read (no AI call): across " + st.n + " comparable listing" + (st.n === 1 ? "" : "s") + " for a " + name + ", the middle half ask " + m0(st.p25) + "–" + m0(st.p75) + " (median " + m0(st.median) + ")."];
  if (v && q.askingPrice) {
    var diff = Math.abs(Math.round(v.vsMedian));
    parts.push("At " + m0(q.askingPrice) + " it's " + (v.vsMedian <= 0 ? m0(diff) + " under" : m0(diff) + " over") + " the median — " + v.verdict.toLowerCase() + ".");
    parts.push(v.tone === "high" ? "Worth asking the dealer to come down toward " + m0(st.median) + "." : v.tone === "ok" ? "A modest offer near " + m0(st.p25) + " is reasonable." : "Priced to sell; check history and condition before moving fast.");
  }
  var conf = result.confidence && result.confidence.level;
  if (conf && conf !== "high") parts.push("Confidence is " + conf + " — the sample is small or spread out.");
  return parts.join(" ");
}

// Criteria's AI price baseline, from the profile's own cars: per model year,
// good / fair / high = 25th / 50th / 75th percentile asking prices.
export function demoBaseline(profile, cars) {
  var p = (profile && profile.params) || {};
  var mine = uniqCars(cars).filter(function (l) { return sameModel(l, p.make, p.model) && l.price > 0; });
  var r100 = function (n) { return Math.round(n / 100) * 100; };
  var band = function (list) {
    var xs = list.map(function (l) { return +l.price; }).sort(function (a, b) { return a - b; });
    var good = pct(xs, 0.25), fair = pct(xs, 0.5), high = pct(xs, 0.75);
    if (xs.length < 3) { good = fair * 0.94; high = fair * 1.06; }
    return { good: r100(good), fair: r100(fair), high: r100(high) };
  };
  if (!mine.length) {
    var cap = +p.maxPrice || 25000;
    return { refMileage: 50000, perThousandMi: 60, tiers: [], default: { good: r100(cap * 0.85), fair: r100(cap * 0.95), high: r100(cap * 1.05) } };
  }
  var byYear = {};
  mine.forEach(function (l) { if (l.year) (byYear[l.year] = byYear[l.year] || []).push(l); });
  var ms = mine.map(milesOf).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
  return {
    refMileage: ms.length ? Math.round(pct(ms, 0.5) / 5000) * 5000 : 50000,
    perThousandMi: 60,
    tiers: Object.keys(byYear).sort().map(function (y) { return Object.assign({ years: y, trim: "" }, band(byYear[y])); }),
    default: band(mine),
  };
}

// The wizard's AI suggestions: the owner's own wording for this make/model when
// a profile exists, plus notes on the trims the market answer listed.
export function demoSuggestion(profile, market, profiles) {
  var p = (profile && profile.params) || {};
  var twin = (profiles || []).find(function (x) { return x && x.params && sameModel({ vehicle: (x.params.make || "") + " " + (x.params.model || "") }, p.make, p.model); });
  var tp = (twin && twin.params) || {};
  var tc = (market && market.trims && market.trims.counts) || {};
  var top = Object.keys(tc).sort(function (a, b) { return tc[b] - tc[a]; }).slice(0, 3);
  return {
    mustHave: tp.mustHave || "", niceToHave: tp.niceToHave || "", dealbreakers: tp.dealbreakers || "",
    avoidYears: [],
    trimNotes: top.map(function (t, i) { return { trim: t, note: (i === 0 ? "Most listed" : "Common") + " trim right now (" + tc[t] + ")" }; }),
    summary: "Demo suggestions — no AI call. " + (twin ? "Borrowed from the owner's own " + twin.name + " profile." : "Nothing in the demo to borrow for this vehicle, so only trim notes."),
  };
}
