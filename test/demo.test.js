import { describe, it, expect } from "vitest";
import { demoScore, demoCount, demoMarketComps, demoPriceAssessment, demoBaseline, demoSuggestion, sameModel, statsOf, isDemoUrl, buildDemoSnapshot, reviewableNotes, autoNotes, userNotes, shiftDateStr, shiftDates, daysSince, prepareDemo, simulateSync, scoreFieldsOf } from "../src/demo.js";
import { reconcile } from "../src/reconcile.js";

var car = function (id, o) {
  return Object.assign({ id: id, vin: "VIN" + id, year: 2021, make: "Subaru", model: "Outback", status: "watch", source: "marketcheck", price: 20000, addedDate: "2026-10-01", lastSeen: "2026-10-30" }, o || {});
};

describe("isDemoUrl", () => {
  it("matches ?demo in any position", () => {
    expect(isDemoUrl("?demo")).toBe(true);
    expect(isDemoUrl("?x=1&demo=1")).toBe(true);
    expect(isDemoUrl("?demo=true")).toBe(true);
    expect(isDemoUrl("?demos")).toBe(false);
    expect(isDemoUrl("")).toBe(false);
  });
});

describe("notes", () => {
  it("splits sync's price notes from the owner's words", () => {
    var n = "Call Tues · ↓ Price $21,000 → $20,000 (2026-10-02) · ask about tires";
    expect(autoNotes(n)).toBe("↓ Price $21,000 → $20,000 (2026-10-02)");
    expect(userNotes(n)).toBe("Call Tues · ask about tires");
  });
  it("lists every car with a memo or own notes, once", () => {
    var d = { listings: [car("a", { memo: "loved it" }), car("b", { notes: "↑ Price $1 → $2 (2026-10-01)" })], candidates: [car("c", { notes: "dealer is slow" })], skipped: [car("a")] };
    expect(reviewableNotes(d).map((x) => x.key)).toEqual(["a", "c"]);
  });
});

describe("buildDemoSnapshot", () => {
  var data = {
    version: 9, autoScore: true,
    settings: { marketcheckKeys: [{ key: "secret" }], mcQuota: { k: 1 }, mcApi: { v: 1 }, homeBase: { n: "Durham, NC" }, budget: 40000 },
    listings: [car("a", { memo: "private", notes: "mine · ↓ Price $21,000 → $20,000 (2026-10-02)" }), car("b", { memo: "keep me" })],
    candidates: [car("c1", { addedDate: "2026-10-20", _candidate: true, fromScheduled: true }), car("c2", { addedDate: "2026-10-25", scoredAt: "2026-10-25T10:00:00Z", scores: { price: 8 } }), car("c3", { addedDate: "2026-10-28" })],
  };
  var s = buildDemoSnapshot(data, { keep: { b: true }, now: new Date("2026-11-01T12:00:00Z"), poolMax: 2 });
  it("drops secrets and turns auto-score off", () => {
    expect(s.data.settings).toEqual({ homeBase: { n: "Durham, NC" }, budget: 40000 });
    expect(s.data.autoScore).toBe(false);
    expect(JSON.stringify(s)).not.toContain("secret");
  });
  it("clears unkept notes but keeps price notes", () => {
    expect(s.data.listings[0].memo).toBe("");
    expect(s.data.listings[0].notes).toBe("↓ Price $21,000 → $20,000 (2026-10-02)");
    expect(s.data.listings[1].memo).toBe("keep me");
  });
  it("holds back the newest queued cars, scored first", () => {
    expect(s.pool.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(s.data.candidates.map((c) => c.id)).toEqual(["c1"]);
    expect(s.data.candidates[0]._candidate).toBeUndefined();
    expect(s.data.candidates[0].fromScheduled).toBeUndefined();
    expect(s.exportedAt).toBe("2026-11-01T12:00:00.000Z");
  });
  it("leaves the input alone", () => {
    expect(data.settings.marketcheckKeys.length).toBe(1);
    expect(data.listings[0].memo).toBe("private");
  });
});

describe("dates", () => {
  it("shifts dates inside strings, not URLs", () => {
    expect(shiftDateStr("2026-10-30", 3)).toBe("2026-11-02");
    expect(shiftDateStr("2026-10-30T08:00:00.000Z", 3)).toBe("2026-11-02T08:00:00.000Z");
    expect(shiftDateStr("↓ Price $1 → $2 (2026-12-30)", 5)).toBe("↓ Price $1 → $2 (2027-01-04)");
    expect(shiftDateStr("https://x.com/2026-10-30/car", 3)).toBe("https://x.com/2026-10-30/car");
    expect(shiftDateStr("VIN 1234-56-78", 3)).toBe("VIN 1234-56-78");
  });
  it("walks objects and arrays", () => {
    expect(shiftDates({ a: ["2026-01-01"], b: { c: "2026-01-02", n: 5 } }, 1)).toEqual({ a: ["2026-01-02"], b: { c: "2026-01-03", n: 5 } });
  });
  it("days since", () => {
    expect(daysSince("2026-11-01T23:00:00Z", new Date("2026-11-07T01:00:00Z"))).toBe(6);
    expect(daysSince("junk", new Date())).toBe(0);
  });
  it("prepareDemo makes the snapshot read as today and re-scrubs", () => {
    var p = prepareDemo({ exportedAt: "2026-11-01T00:00:00Z", data: { autoScore: true, settings: { marketcheckKeys: ["x"] }, lastSynced: "2026-11-01T09:00:00Z", listings: [car("a")] }, pool: [car("p")] }, new Date("2026-11-07T12:00:00Z"));
    expect(p.data.lastSynced).toBe("2026-11-07T09:00:00Z");
    expect(p.data.listings[0].lastSeen).toBe("2026-11-05");
    expect(p.pool[0].addedDate).toBe("2026-10-07");
    expect(p.data.settings.marketcheckKeys).toEqual([{ key: "demo-key-DEMO", label: "Demo key" }]);
    expect(p.data.settings.mcQuota.snaps.DEMO).toMatchObject({ remaining: 382, limit: 500, reset: "2026-12-01T00:00:00.000Z" });
    expect(p.data.autoScore).toBe(true); // simulated scoring
    expect(prepareDemo(null)).toBeNull();
  });
});

describe("simulateSync", () => {
  var listings = [car("a", { dom: 10 }), car("b", { price: 15050 }), car("c"), car("d", { dom: 90 }), car("e", { status: "rejected" }), car("f", { goneAt: "2026-10-01" })];
  var pool = [car("p1", { scores: { price: 9 }, scoredAt: "x" }), car("p2"), car("p3"), car("p4")];
  it("releases pool cars, drops two prices, and sells one on the first sync", () => {
    var r = simulateSync(listings, pool, 0);
    expect(r.released.map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
    expect(r.goneVins).toEqual(["VINd"]); // longest on the market
    var byId = {};
    r.listings.forEach((l) => { byId[l.id] = l; });
    expect(byId.a.price).toBe(19400);
    expect(byId.b.price).toBe(14500);
    expect(byId.c.price).toBe(20000);
    expect(byId.d).toBeUndefined();
    expect(byId.e).toBeUndefined();
  });
  it("later syncs release the rest, then nothing new; no more sales", () => {
    var r = simulateSync(listings, pool, 1);
    expect(r.released.map((c) => c.id)).toEqual(["p4"]);
    expect(r.goneVins).toEqual([]);
    expect(simulateSync(listings, pool, 2).released).toEqual([]);
  });
  it("feeds reconcile like a real sync", () => {
    var r = simulateSync(listings, pool, 0);
    var rec = reconcile(listings, r.listings, "2026-11-07", { goneVins: r.goneVins });
    expect(rec.summary.priceUpdates).toBe(2);
    expect(rec.summary.notSeen).toBe(1);
    expect(rec.candidates.map((c) => c.vin)).toEqual(["VINp1", "VINp2", "VINp3"]);
    expect(Object.assign({}, rec.candidates[0], scoreFieldsOf(pool[0])).scores).toEqual({ price: 9 });
  });
});

describe("demoScore", () => {
  var crit = [{ id: "price" }, { id: "mileage" }, { id: "color" }];
  var refs = [
    car("r1", { profileId: "p1", trim: "Premium", price: 22000, miles: 40000, scoredAt: "x", scores: { price: 6, mileage: 6, color: 8 } }),
    car("r2", { profileId: "p2", trim: "Premium", price: 21000, miles: 41000, scoredAt: "x", scores: { price: 2, mileage: 2, color: 2 } }),
    car("r3", { profileId: "p1", price: 9000, miles: 40000, scores: { price: 10 } }), // not scored
  ];
  it("copies the nearest scored car in the same profile, nudging price and mileage", () => {
    var r = demoScore(car("x", { profileId: "p1", trim: "Premium", price: 19000, miles: 64000 }), refs, crit);
    expect(r.ok).toBe(true);
    expect(r.scores).toEqual({ price: 8, mileage: 4, color: 8 });
    expect(r.rationales.price).toBe("Demo estimate: $19,000 vs $22,000 on a similar 2021 Subaru Outback Premium.");
    expect(r.summary).toMatch(/^Demo score — no AI call\. Modeled on a similar 2021 Subaru Outback Premium at \$22,000/);
  });
  it("clamps to 1–10 and never models a car on itself", () => {
    var self = demoScore(car("r1", { profileId: "p1", trim: "Premium", price: 60000, miles: 40000 }), refs, crit);
    expect(self.scores.color).toBe(2); // modeled on r2 (other profile), not itself
    expect(self.scores.price).toBe(1);
    expect(demoScore(car("y", { profileId: "p1", price: 1000 }), refs, crit).scores.price).toBe(10);
  });
  it("middle scores with nothing to go on", () => {
    expect(demoScore(car("z"), [], crit).scores).toEqual({ price: 5, mileage: 5, color: 5 });
  });
});

describe("demo market answers", () => {
  var m = (id, o) => Object.assign({ id: id, vin: "M" + id, vehicle: "Subaru Outback", year: 2021, trim: "Premium", price: 20000, mileage: 40000, baseColor: "Blue", drivetrain: "4WD" }, o || {});
  var cars = [m(1), m(2, { year: 2020, trim: "Limited", price: 24000, mileage: 30000, baseColor: "Gray" }), m(3, { year: 2022, price: 26000, mileage: 20000 }),
    m(4, { vehicle: "Toyota RAV4" }), m(1)];
  var profiles = [{ id: "ob", name: "Outback", params: { make: "Subaru", model: "Outback", mustHave: "AWD", dealbreakers: "XT" } }];
  it("matches on make/model", () => {
    expect(sameModel(cars[0], "subaru", "outback")).toBe(true);
    expect(sameModel(cars[3], "Subaru", "")).toBe(false);
    expect(sameModel({ make: "Subaru", model: "Outback" }, "Subaru", "Outback")).toBe(true);
  });
  it("count: facets + stats from the demo's cars, within the years", () => {
    var r = demoCount({ params: { make: "Subaru", model: "Outback", years: "2020-2021" } }, cars, [], null);
    expect(r.numFound).toBe(2);
    expect(r.trims.counts).toEqual({ Premium: 1, Limited: 1 });
    expect(r.years.counts).toEqual({ 2021: 1, 2020: 1 });
    expect(r.stats.price.median).toBe(22000);
  });
  it("count: stored nationwide breakdowns win and set the total", () => {
    var r = demoCount({ params: { make: "Subaru", model: "Outback" } }, cars, profiles, { ob: { count: 812, trims: { counts: { Premium: 400, Touring: 90 }, unlisted: 0, at: "x" } } });
    expect(r.numFound).toBe(812);
    expect(r.trims).toEqual({ counts: { Premium: 400, Touring: 90 }, unlisted: 0 });
    expect(r.colors.counts).toEqual({ Blue: 2, Gray: 1 });
  });
  it("stats percentiles", () => {
    expect(statsOf([10, 20, 30, 40, 50]).percentiles["25.0"]).toBe(20);
    expect(statsOf([])).toBeNull();
  });
  it("market comps: made-up, near the demo's own, deterministic", () => {
    var a = demoMarketComps({ make: "Subaru", model: "Outback", year: 2021 }, cars, 6);
    expect(a.length).toBe(6);
    expect(a.every((c) => c.dealer === "Simulated market listing" && /^DEMOCOMP/.test(c.vin))).toBe(true);
    a.forEach((c) => { expect(c.price).toBeGreaterThan(18000); expect(c.price).toBeLessThan(28000); });
    expect(demoMarketComps({ make: "Subaru", model: "Outback", year: 2021 }, cars, 6)).toEqual(a);
    expect(demoMarketComps({ make: "Honda", model: "Fit" }, cars)).toEqual([]);
  });
  it("price read from the numbers", () => {
    var t = demoPriceAssessment({ year: 2021, make: "Subaru", model: "Outback", askingPrice: 23000 },
      { stats: { n: 5, p25: 20000, median: 22000, p75: 24000 }, verdict: { vsMedian: 1000, verdict: "Fair — typical range", tone: "ok" }, confidence: { level: "low" } });
    expect(t).toBe("Demo read (no AI call): across 5 comparable listings for a 2021 Subaru Outback, the middle half ask $20,000–$24,000 (median $22,000). At $23,000 it's $1,000 over the median — fair — typical range. A modest offer near $20,000 is reasonable. Confidence is low — the sample is small or spread out.");
  });
  it("baseline: per-year bands from the profile's cars", () => {
    var b = demoBaseline(profiles[0], cars);
    expect(b.tiers.map((t) => t.years)).toEqual(["2020", "2021", "2022"]);
    expect(b.tiers[1]).toEqual({ years: "2021", trim: "", good: 18800, fair: 20000, high: 21200 });
    expect(b.refMileage).toBe(30000);
    expect(demoBaseline({ params: { make: "Honda", model: "Fit", maxPrice: 10000 } }, cars).default).toEqual({ good: 8500, fair: 9500, high: 10500 });
  });
  it("suggestions borrow the owner's wording", () => {
    var s = demoSuggestion({ params: { make: "Subaru", model: "Outback" } }, { trims: { counts: { Premium: 9, Limited: 4 } } }, profiles);
    expect(s.mustHave).toBe("AWD");
    expect(s.trimNotes[0]).toEqual({ trim: "Premium", note: "Most listed trim right now (9)" });
    expect(s.summary).toMatch(/owner's own Outback profile/);
    expect(demoSuggestion({ params: { make: "Honda", model: "Fit" } }, {}, profiles).mustHave).toBe("");
  });
  it("prepareDemo flags the two newest queued cars as found by the background sync", () => {
    var p = prepareDemo({ exportedAt: "2026-11-01T00:00:00Z", data: { settings: {}, listings: [], candidates: [m(1, { addedDate: "2026-10-01" }), m(2, { addedDate: "2026-10-09" }), m(3, { addedDate: "2026-10-05" })] } }, new Date("2026-11-01T12:00:00Z"));
    expect(p.data.candidates.map((c) => !!c.fromScheduled)).toEqual([false, true, true]);
  });
});
