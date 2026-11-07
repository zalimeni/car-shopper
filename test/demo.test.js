import { describe, it, expect } from "vitest";
import { isDemoUrl, buildDemoSnapshot, reviewableNotes, autoNotes, userNotes, shiftDateStr, shiftDates, daysSince, prepareDemo, simulateSync, scoreFieldsOf } from "../src/demo.js";
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
    expect(p.data.settings.marketcheckKeys).toBeUndefined();
    expect(p.data.autoScore).toBe(false);
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
