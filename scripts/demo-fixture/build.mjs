#!/usr/bin/env node
// Build the demo fixture (public/demo/snapshot.json) from an export of the
// owner's data: a demo snapshot ({ data, pool } — e.g. the public demo row) or a
// raw app-state blob.
//
//   node scripts/demo-fixture/build.mjs <export.json> [--out public/demo/snapshot.json] [--photos photos.json] [--skip-photos dead.json]
//
// --skip-photos: a JSON array of photo URLs thumb.py couldn't fetch (it prints
// them); cars with those photos are passed over for the next-best pick.
//
// What it does — on purpose, nothing in this file is copied from the owner's
// data (no names, VINs, dealers or free text), so the script itself is safe to
// commit:
//  - keeps 4 profiles (3 active) and picks ~35 cars by rule: watchlist, sold,
//    rejected, review queue, the demo-sync pool, skipped;
//  - synthesizes identities: VIN serials (valid check digit, real make/model
//    prefix), fictional dealer names, no dealer links, dealer coordinates at the
//    city's center, and replaces each dealer's name wherever AI text mentions it;
//  - rewrites free text neutral (profile must-haves, reject reasons, memo) and
//    keeps only sync-written notes;
//  - fills gaps: price histories (a few recent drops) for watchlist cars;
//  - writes photos.json ({ key: source photo URL }, to the temp dir by default —
//    it holds real URLs, never commit it) for thumb.py, which turns each into
//    public/demo/cars/<key>.webp. The fixture points at those files.
// Re-check the output with `npm test` (test/demoFixture.test.js) before
// committing: it fails on anything that looks sensitive.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { trimHideReason } from "../../src/trims.js";
import { colorHideReason } from "../../src/colors.js";

const args = process.argv.slice(2);
const inPath = args[0];
if (!inPath) { console.error("usage: build.mjs <export.json> [--out file] [--photos file]"); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const outPath = opt("--out", "public/demo/snapshot.json");
// photos.json holds the real dealer photo URLs (VINs in their paths): keep it
// out of the repo — default to the OS temp dir (also .gitignored if moved).
const photosPath = opt("--photos", path.join(os.tmpdir(), "demo-fixture-photos.json"));
const deadPhotos = new Set(opt("--skip-photos") ? JSON.parse(fs.readFileSync(opt("--skip-photos"), "utf8")) : []);

let raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
if (Array.isArray(raw)) raw = raw[0];
if (raw && raw.data && raw.data.data) raw = raw.data; // a demo_snapshot row
const src = raw.data && raw.pool ? raw : { data: raw, pool: [], exportedAt: new Date().toISOString() };
const D = src.data;
const exportedAt = src.exportedAt || new Date().toISOString();
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const nowMs = Date.parse(exportedAt);

// ── deterministic randomness ──
let seed = 20261109;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pickN = (arr, n) => arr.slice(0, n);

// ── profiles ──
const KEEP = {
  "tucson-hybrid": { active: true, role: "SUV",
    mustHave: "AWD (standard on the hybrid); 2025, or a 2024 built after March 2024 (rear seat-belt pretensioners); rear cross-traffic alert; pre-purchase inspection allowed",
    niceToHave: "SEL Convenience trim; heated front seats; power driver seat; one-owner clean Carfax",
    dealbreakers: "2024 built before April 2024; salt-belt history; seller refuses a pre-purchase inspection; non-hybrid Tucson" },
  "subaru-outback": { active: true, role: "SUV",
    mustHave: "AWD; non-turbo 2.5L",
    niceToHave: "Premium or Limited trim, moonroof, heated seats, power driver seat",
    dealbreakers: "Turbo XT / Onyx XT / Wilderness; open CVT or brake recalls" },
  "bolt-ev": { active: true, role: "Commuter",
    mustHave: "Battery recall closed with a documented pack or module replacement; battery health 80%+; pre-purchase inspection allowed",
    niceToHave: "Replacement pack installed 2022 or later (fresh 8-year warranty); 2019 over 2018",
    dealbreakers: "2017 model year; software-only or undocumented recall fix; seller refuses a pre-purchase inspection" },
  "rav4-hybrid": { active: false, role: "SUV",
    mustHave: "AWD, hybrid", niceToHave: "Weather package, CPO, wireless CarPlay (2022)", dealbreakers: "" },
};
const profiles = (D.profiles || []).filter((p) => KEEP[p.id]).map((p) => {
  const k = KEEP[p.id];
  const params = Object.assign({}, p.params, { mustHave: k.mustHave, niceToHave: k.niceToHave, dealbreakers: k.dealbreakers });
  delete params.notes;
  return { id: p.id, name: p.name, role: k.role, active: k.active, params };
});
const pid = new Set(profiles.map((p) => p.id));

// ── the pool of cars to choose from ──
const tag = (l, from) => Object.assign({}, l, { _from: from });
const all = [].concat(
  (D.listings || []).map((l) => tag(l, l.status)),
  (D.candidates || []).map((l) => tag(l, "queued")),
  (src.pool || []).map((l) => tag(l, "pool")),
  (D.skipped || []).map((l) => tag(l, "skipped")),
).filter((l) => pid.has(l.profileId) && l.vin && l.photo && !deadPhotos.has(l.photo) && l.price > 0);
const used = new Set();
const score = (l) => l.compositeScore || 0;
// Cars the profile's own trim / color filters would hide (fine for rejected or
// skipped, not for the watchlist, the queue or the sync pool).
const profById = Object.fromEntries(profiles.map((p) => [p.id, p]));
const shows = (l) => !trimHideReason(l, profById[l.profileId].params) && !colorHideReason(l, profById[l.profileId].params);
let mustShow = true;
function take(profileId, froms, n, sort) {
  const list = all.filter((l) => l.profileId === profileId && froms.includes(l._from) && !used.has(l.vin) && (!mustShow || shows(l)))
    .sort(sort || ((a, b) => (b.scoredAt ? 1 : 0) - (a.scoredAt ? 1 : 0) || score(b) - score(a)));
  const out = pickN(list, n);
  out.forEach((l) => used.add(l.vin));
  return out;
}
const newest = (a, b) => String(b.addedDate || "").localeCompare(String(a.addedDate || ""));
// Like take(), topping up from any other car of the profile when the preferred
// statuses run short (e.g. too few usable photos).
const ANY = ["watch", "queued", "pool", "skipped", "rejected", "sold"];
function takeN(profileId, froms, n, sort) {
  const got = take(profileId, froms, n, sort);
  return got.length < n ? got.concat(take(profileId, ANY, n - got.length, sort)) : got;
}
const sel = {};
Object.assign(sel, {
  watch: [...takeN("tucson-hybrid", ["watch"], 4), ...takeN("bolt-ev", ["watch"], 1), ...takeN("subaru-outback", ["rejected", "skipped"], 3)],
  sold: [...takeN("tucson-hybrid", ["sold"], 1), ...takeN("bolt-ev", ["sold"], 1)],
  queued: [...takeN("tucson-hybrid", ["queued"], 3, newest), ...takeN("subaru-outback", ["skipped"], 2), ...takeN("bolt-ev", ["skipped", "sold", "rejected"], 1)],
  pool: [...takeN("tucson-hybrid", ["pool", "queued"], 4), ...takeN("subaru-outback", ["skipped"], 3), ...takeN("bolt-ev", ["pool", "skipped", "sold", "rejected"], 2)],
});
mustShow = false;
Object.assign(sel, {
  rejected: [...takeN("tucson-hybrid", ["rejected"], 3), ...takeN("subaru-outback", ["rejected", "skipped"], 2)],
  skipped: [...takeN("rav4-hybrid", ["skipped"], 2), ...takeN("tucson-hybrid", ["skipped", "queued"], 2), ...takeN("subaru-outback", ["skipped"], 1)],
});

// ── synthetic identities ──
const VIN_MAP = "0123456789.ABCDEFGH..JKLMN.P.R..STUVWXYZ";
const VIN_VAL = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export function vinCheck(v) {
  let sum = 0;
  for (let i = 0; i < 17; i++) { const c = v[i]; sum += (/\d/.test(c) ? +c : VIN_VAL[c] || 0) * VIN_W[i]; }
  const r = sum % 11;
  return r === 10 ? "X" : String(r);
}
function fakeVin(real) {
  const v = String(real).toUpperCase().split("");
  for (let i = 11; i < 17; i++) v[i] = String(Math.floor(rnd() * 10)); // serial
  v[8] = "0";
  v[8] = vinCheck(v.join(""));
  return v.join("");
}
const FIRST = ["Larkmoor", "Kestrelwood", "Bramblegate", "Tallowmere", "Quillstone", "Fernhollow", "Ashgrove", "Wrenfield", "Copperline", "Marlowe Bend", "Ridgeholt", "Saltmarsh", "Pinecrest Hollow", "Thistleway"];
const dealerNames = {};
let fi = 0;
function fakeDealer(l) {
  const key = (l.dealer || "") + "|" + (l.location || "");
  if (!dealerNames[key]) {
    const base = FIRST[fi++ % FIRST.length];
    const make = String(l.vehicle || "").split(" ")[0];
    dealerNames[key] = l.dealerType === "Independent" || l.dealerType === "independent" ? base + " Auto Sales" : base + " " + make;
  }
  return dealerNames[key];
}

// City centers from the app's own location list (ST|City|ZIP|lat|lon).
const centers = {};
for (const line of fs.readFileSync("public/locations.txt", "utf8").split("\n")) {
  const [st, city, , lat, lon] = line.split("|");
  const k = (city + "|" + st).toLowerCase();
  if (st && lat && !centers[k]) centers[k] = [+lat, +lon];
}

const REJECT = ["Price is high for the miles", "Trim is missing features I want", "Too far to ship", "Accident on the history report", "Not a color I'd live with"];
const MEMO = "Carfax shows regular oil changes. Confirm the build date on the door-jamb label before going further.\n\nDealer says it can be sold as CPO.";

function textSwap(s, swaps) {
  if (typeof s !== "string") return s;
  let t = s;
  for (const [a, b] of swaps) if (a && a.length > 3) t = t.split(a).join(b);
  t = t.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "(VIN on file)");
  return t;
}
const SCORE_FIELDS = ["scores", "aiSummary", "aiRationales", "scoredAt", "compositeScore", "dealRating"];
const KEEP_FIELDS = ["vin", "vehicle", "year", "trim", "drivetrain", "price", "fees", "mileage", "dealer", "dealerType", "cpo", "location", "state",
  "color", "baseColor", "colorSource", "dom", "mcSeen", "carfax_1_owner", "carfax_clean_title", "price_change_percent", "msrp", "profileId", "source",
  "addedDate", "lastSeen", "lastChecked", "priceHistory", "notes", "tags"].concat(SCORE_FIELDS);

let n = 0;
const photos = {};
function clean(l, status) {
  const key = "car-" + String(++n).padStart(2, "0");
  const o = {};
  KEEP_FIELDS.forEach((k) => { if (l[k] != null) o[k] = JSON.parse(JSON.stringify(l[k])); });
  const realDealer = l.dealer || "";
  o.vin = fakeVin(l.vin);
  o.dealer = fakeDealer(l);
  const c = centers[(String(l.location || "") + "|" + String(l.state || "")).toLowerCase()];
  if (c) { o.dLat = c[0]; o.dLon = c[1]; }
  o.link = "";
  o.photo = "/demo/cars/" + key + ".webp";
  photos[key] = l.photo;
  // AI text: the real dealer's name (and its first two words) become the fictional one.
  const words = realDealer.split(/\s+/);
  const swaps = [[realDealer, o.dealer], [words.slice(0, 2).join(" "), o.dealer], [String(l.vin), "(VIN on file)"]];
  if (o.aiSummary) o.aiSummary = textSwap(o.aiSummary, swaps);
  if (o.aiRationales) {
    const r = {};
    Object.keys(o.aiRationales).forEach((k) => { r[k] = textSwap(o.aiRationales[k], swaps); });
    if (r.dealer) r.dealer = /independent/i.test(o.dealerType || "")
      ? "Independent dealer: no franchise reconditioning or CPO program behind it, so average."
      : "Franchise dealer: brand-trained service and a CPO path, a modest plus.";
    o.aiRationales = r;
  }
  // Only notes sync wrote (price changes) survive.
  o.notes = String(o.notes || "").split(" · ").filter((x) => /^[↓↑] Price /.test(x.trim())).join(" · ");
  o.status = status;
  return { key, o };
}

// Price history for a watchlist car: 1–3 steps down to today's price over ~5 weeks.
function synthHistory(o, recentDrop) {
  const hist = Array.isArray(o.priceHistory) ? o.priceHistory.filter((p) => p && p.price) : [];
  if (hist.length >= 3 && !recentDrop) return;
  const steps = 1 + Math.floor(rnd() * 2) + (recentDrop ? 1 : 0);
  const pts = [];
  let p = o.price;
  let t = nowMs - (recentDrop ? 2 : 6) * DAY;
  pts.unshift({ date: iso(t), price: p });
  for (let i = 0; i < steps; i++) {
    p = Math.round((p * (1.02 + rnd() * 0.03)) / 100) * 100 + 99 * (rnd() < 0.5 ? 1 : 0);
    t -= (8 + Math.floor(rnd() * 9)) * DAY;
    pts.unshift({ date: iso(t), price: p });
  }
  o.priceHistory = pts;
  o.addedDate = pts[0].date;
  o.notes = pts.slice(1).map((x, i) => "↓ Price $" + pts[i].price.toLocaleString("en-US") + " → $" + x.price.toLocaleString("en-US") + " (" + x.date + ")").join(" · ");
  if (recentDrop) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    o.reviewPending = true;
    o.lastChange = { type: "price", from: a.price, to: b.price, dir: "↓", at: b.date };
  }
}

const listings = [];
sel.watch.forEach((l, i) => {
  const { key, o } = clean(l, "watch");
  o.id = key;
  synthHistory(o, i % 3 === 1); // a few "Updated" cards
  o.lastSeen = o.lastChecked = iso(nowMs - DAY);
  listings.push(o);
});
listings[0].memo = MEMO;
listings[0].tags = ["Needs CPO", "Looks good"];
if (listings[2]) listings[2].tags = ["Has roof rack"];
sel.sold.forEach((l) => { const { key, o } = clean(l, "sold"); o.id = key; listings.push(o); });
sel.rejected.forEach((l, i) => { const { key, o } = clean(l, "rejected"); o.id = key; o.rejectReason = REJECT[i % REJECT.length]; listings.push(o); });
const queue = (list) => list.map((l) => { const { o } = clean(l, "watch"); delete o.status; return Object.assign(o, { status: "watch" }); });
const candidates = queue(sel.queued);
const pool = queue(sel.pool);
const skipped = sel.skipped.map((l) => { const { o } = clean(l, "watch"); o.skippedAt = iso(nowMs - 9 * DAY); return o; });

const st = Object.assign({}, D.settings || {});
const settings = {
  budget: st.budget, taxRate: st.taxRate, tagline: "3 profiles · Durham NC · ≤$40K",
  homeBase: st.homeBase, saltMode: st.saltMode, franchiseOnly: !!st.franchiseOnly,
  defaultExcludeColors: st.defaultExcludeColors || [], compareCols: st.compareCols || null,
  mcProfiles: Object.fromEntries(Object.entries(st.mcProfiles || {}).filter(([k]) => pid.has(k))),
};

const fixture = {
  demoVersion: 1, exportedAt,
  data: {
    version: D.version, onboarded: true, autoScore: false, scoreModel: D.scoreModel,
    profiles, criteria: D.criteria, globalReqs: D.globalReqs || [],
    listings, candidates, skipped, settings, lastSynced: new Date(nowMs - 3 * 3600000).toISOString(),
  },
  pool,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 1) + "\n");
fs.writeFileSync(photosPath, JSON.stringify(photos, null, 1) + "\n");

// Leftovers check (printed, never written): any real dealer name or VIN still in the text?
const out = JSON.stringify(fixture);
const leaks = [];
all.forEach((l) => {
  if (l.vin && out.includes(l.vin)) leaks.push("VIN " + l.vin.slice(0, 4) + "…");
  const d = String(l.dealer || "");
  if (d.length > 5 && out.includes(d)) leaks.push("dealer name #" + all.indexOf(l));
});
console.log(JSON.stringify({ listings: listings.length, candidates: candidates.length, pool: pool.length, skipped: skipped.length,
  byStatus: listings.reduce((m, l) => (m[l.status] = (m[l.status] || 0) + 1, m), {}), leaks: [...new Set(leaks)] }));
