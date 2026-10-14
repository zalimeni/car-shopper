import { describe, it, expect } from "vitest";
import { dedupeKeyEntries, ingestSnaps, recordSyncCalls, mergeReports, summarize, syncCost, syncsLeft, gaugeTone, keyIdOf } from "../src/quota.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const keys = [{ key: "sk-aaaa1111", label: "Personal" }, { key: "sk-bbbb2222", label: "" }];

describe("ingestSnaps / mergeReports", () => {
  it("stores the latest snapshot per key id", () => {
    const s = ingestSnaps(null, [{ id: "1111", remaining: 400, limit: 500, reset: "2026-11-01T00:00:00Z" }], "t1");
    expect(s.snaps["1111"]).toMatchObject({ remaining: 400, limit: 500, reset: "2026-11-01T00:00:00Z", at: "t1", exhausted: false });
  });
  it("a sparse report can't blank what we knew", () => {
    const a = ingestSnaps(null, [{ id: "1111", remaining: 400, limit: 500, reset: "R" }], "t1");
    const b = ingestSnaps(a, [{ id: "1111", remaining: 380 }], "t2");
    expect(b.snaps["1111"]).toMatchObject({ remaining: 380, limit: 500, reset: "R", at: "t2" });
  });
  it("an exhausted key is recorded as 0 left even without a count", () => {
    expect(ingestSnaps(null, [{ id: "1111", exhausted: true, limit: 500 }], "t").snaps["1111"].remaining).toBe(0);
  });
  it("keeps the last sync cost when snapshots update", () => {
    const a = recordSyncCalls(null, 14, "t1");
    expect(ingestSnaps(a, [{ id: "1111", remaining: 1 }], "t2").lastSync).toEqual({ calls: 14, at: "t1" });
    expect(recordSyncCalls(a, 0, "t3").lastSync.calls).toBe(14);
  });
  it("merging per-location reports keeps the lowest remaining and a sticky exhausted flag", () => {
    const m = mergeReports([{ id: "1111", remaining: 300, limit: 500 }], [{ id: "1111", remaining: 290, limit: 500 }, { id: "2222", remaining: 5, exhausted: true }]);
    expect(m.find((r) => r.id === "1111").remaining).toBe(290);
    expect(m.find((r) => r.id === "2222").exhausted).toBe(true);
    expect(mergeReports([{ id: "1111", remaining: 0, exhausted: true }], [{ id: "1111", remaining: 0 }])[0].exhausted).toBe(true);
  });
});

describe("summarize", () => {
  const store = (snaps) => ({ snaps });
  it("sums capacity across keys and finds the key in use (first with calls left)", () => {
    const s = summarize(keys, store({ "1111": { remaining: 0, limit: 500, exhausted: true, reset: "2026-11-01T00:00:00Z" }, "2222": { remaining: 300, limit: 500, reset: "2026-11-02T00:00:00Z" } }), NOW);
    expect(s.totalRemaining).toBe(300);
    expect(s.totalLimit).toBe(1000);
    expect(s.fraction).toBeCloseTo(0.3, 5);
    expect(s.rows.map((r) => r.state)).toEqual(["spent", "in use"]);
    expect(s.activeId).toBe("2222");
    expect(s.nextReset).toBe(Date.parse("2026-11-01T00:00:00Z"));
  });
  it("marks later keys as standby while an earlier one still has calls", () => {
    const s = summarize(keys, store({ "1111": { remaining: 100, limit: 500, reset: "2026-11-01T00:00:00Z" }, "2222": { remaining: 500, limit: 500, reset: "2026-11-01T00:00:00Z" } }), NOW);
    expect(s.rows.map((r) => r.state)).toEqual(["in use", "standby"]);
    expect(s.totalRemaining).toBe(600);
  });
  it("treats an unmeasured key as unknown, excluded from the fraction", () => {
    const s = summarize(keys, store({ "1111": { remaining: 250, limit: 500, reset: "2026-11-01T00:00:00Z" } }), NOW);
    expect(s.unknown).toBe(1);
    expect(s.fraction).toBeCloseTo(0.5, 5);
    expect(s.rows[1].state).toBe("unmeasured");
  });
  it("assumes a key whose reset date has passed has renewed", () => {
    const s = summarize(keys, store({ "1111": { remaining: 0, limit: 500, exhausted: true, reset: "2026-10-01T00:00:00Z" } }), NOW);
    expect(s.rows[0]).toMatchObject({ assumed: true, remaining: 500 });
    expect(s.rows[0].state).toBe("in use");
  });
  it("has no fraction at all before anything is measured", () => {
    const s = summarize(keys, null, NOW);
    expect(s.fraction).toBeNull();
    expect(s.unknown).toBe(2);
  });
  it("shows the shared key only when there is no configured list — otherwise it's ignored entirely", () => {
    expect(summarize([], store({}), NOW).rows.map((r) => r.id)).toEqual(["shared"]);
    // a stale shared snapshot must not leak into the rows or totals once you have keys
    const s = summarize(keys, store({ shared: { remaining: 40, limit: 100 }, "1111": { remaining: 10, limit: 500 } }), NOW);
    expect(s.rows.map((r) => r.id)).toEqual(["1111", "2222"]);
    expect(s.totalRemaining).toBe(10);
    expect(s.totalLimit).toBe(500);
  });
  it("derives key ids the same way the server does", () => {
    expect(keyIdOf("sk-aaaa1111")).toBe("1111");
  });
});

describe("syncCost / syncsLeft", () => {
  const P = (id, pt) => ({ id, params: { make: "M", model: id, powertrain: pt } });
  it("merges profiles with the same powertrain filter into one query per location", () => {
    const c = syncCost([P("a", "Hybrid"), P("b", "hev"), P("c", "")], 3, null);
    expect([c.profiles, c.groups, c.hubs]).toEqual([3, 2, 3]);
    expect(c.min).toBe(6);               // 2 query groups x 3 locations, one page each
    expect(c.max).toBe((8 + 4) * 3);     // merged pair may page 8 (2 x 4), the single 4
    expect(c.perHub).toEqual({ min: 2, max: 12 });
    expect(c.liveSearch).toEqual({ min: 1, max: 4 });
  });
  it("caps a big merged group at the 500-row (10-page) pagination ceiling", () => {
    const five = ["a", "b", "c", "d", "e"].map((x) => P(x, ""));
    expect(syncCost(five, 1, null).max).toBe(10);
  });
  it("converts remaining calls to whole syncs (best, worst, and at the measured cost)", () => {
    const c = syncCost([P("a", ""), P("b", "")], 2, { calls: 7 });
    expect([c.min, c.max]).toEqual([2, 16]);
    expect(syncsLeft(500, c)).toEqual({ best: 250, worst: 31, measured: 71 });
  });
  it("returns null when there is nothing to estimate", () => {
    expect(syncsLeft(500, syncCost([], 2, null))).toBeNull();
    expect(syncsLeft(null, syncCost([P("a", "")], 1, null))).toBeNull();
  });
});

describe("gaugeTone", () => {
  it("is green, amber, red by share left, and grey when unknown", () => {
    expect([gaugeTone(0.9), gaugeTone(0.4), gaugeTone(0.2), gaugeTone(0.15), gaugeTone(0.05), gaugeTone(0), gaugeTone(null)]).toEqual(["good", "good", "warn", "warn", "bad", "bad", "none"]);
  });
});

describe("dedupeKeyEntries (Settings save)", () => {
  it("drops repeats of the same key, keeping the first position", () => {
    expect(dedupeKeyEntries([{ key: "A", label: "one" }, { key: "B", label: "" }, { key: "A", label: "again" }])).toEqual([{ key: "A", label: "one" }, { key: "B", label: "" }]);
  });
  it("treats keys that differ only by surrounding whitespace as the same", () => {
    expect(dedupeKeyEntries([{ key: "A" }, { key: "  A " }]).map((e) => e.key)).toEqual(["A"]);
  });
  it("lets the kept entry adopt a label from a later copy if it had none", () => {
    expect(dedupeKeyEntries([{ key: "A", label: "" }, { key: "A", label: "Personal" }])).toEqual([{ key: "A", label: "Personal" }]);
  });
  it("drops blank keys, tolerates junk, and returns [] for nothing", () => {
    expect(dedupeKeyEntries([{ key: "" }, { key: "   " }, null, undefined, {}])).toEqual([]);
    expect(dedupeKeyEntries(undefined)).toEqual([]);
  });
});
