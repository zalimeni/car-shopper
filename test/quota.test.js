import { describe, it, expect } from "vitest";
import { dedupeKeyEntries, ingestSnaps, recordSyncCalls, mergeReports, summarize, syncsLeft, gaugeTone, keyIdOf } from "../src/quota.js";

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
  it("presumes a never-used key has the free plan's 500 calls until it reports", () => {
    const s = summarize(keys, store({ "1111": { remaining: 250, limit: 500, reset: "2026-11-01T00:00:00Z" } }), NOW);
    expect(s.rows[1]).toMatchObject({ presumed: true, remaining: 500, limit: 500, state: "standby" });
    expect([s.unknown, s.presumed, s.totalRemaining, s.totalLimit]).toEqual([0, 1, 750, 1000]);
    expect(s.fraction).toBeCloseTo(0.75, 5);
  });
  it("once a key reports, its real numbers replace the presumption", () => {
    const s = summarize(keys, store({ "2222": { remaining: 80, limit: 100, reset: "2026-11-01T00:00:00Z" } }), NOW);
    expect(s.rows[1]).toMatchObject({ remaining: 80, limit: 100 });
    expect(s.rows[1].presumed).toBeFalsy();
  });
  it("assumes a key whose reset date has passed has renewed", () => {
    const s = summarize(keys, store({ "1111": { remaining: 0, limit: 500, exhausted: true, reset: "2026-10-01T00:00:00Z" } }), NOW);
    expect(s.rows[0]).toMatchObject({ assumed: true, remaining: 500 });
    expect(s.rows[0].state).toBe("in use");
  });
  it("before anything is measured your keys read as full, presumed", () => {
    const s = summarize(keys, null, NOW);
    expect([s.fraction, s.presumed, s.unknown, s.totalRemaining]).toEqual([1, 2, 0, 1000]);
    expect(s.rows.map((r) => r.state)).toEqual(["in use", "standby"]);
  });
  it("the shared server key isn't presumed (its plan is unknown)", () => {
    const s = summarize([], null, NOW);
    expect([s.fraction, s.unknown, s.presumed]).toEqual([null, 1, 0]);
    expect(s.rows[0].state).toBe("unmeasured");
  });
  it("shows the shared key only when there is no configured list — otherwise it's ignored entirely", () => {
    expect(summarize([], store({}), NOW).rows.map((r) => r.id)).toEqual(["shared"]);
    // a stale shared snapshot must not leak into the rows or totals once you have keys
    const s = summarize(keys, store({ shared: { remaining: 40, limit: 100 }, "1111": { remaining: 10, limit: 500 } }), NOW);
    expect(s.rows.map((r) => r.id)).toEqual(["1111", "2222"]);
    expect(s.totalRemaining).toBe(10 + 500); // 2222 never used: presumed 500
    expect(s.totalLimit).toBe(1000); // never the shared key's 100
  });
  it("derives key ids the same way the server does", () => {
    expect(keyIdOf("sk-aaaa1111")).toBe("1111");
  });
});

describe("syncsLeft", () => {
  it("converts remaining calls to whole syncs, best and worst case", () => {
    expect(syncsLeft(500, { min: 2, max: 16 })).toEqual({ best: 250, worst: 31 });
  });
  it("returns null when there is nothing to estimate", () => {
    expect(syncsLeft(500, { min: 0, max: 0 })).toBeNull();
    expect(syncsLeft(null, { min: 1, max: 4 })).toBeNull();
  });
});

describe("gaugeTone", () => {
  it("is neutral, then amber, then red as the share USED grows; grey when unknown", () => {
    expect([gaugeTone(0), gaugeTone(0.5), gaugeTone(0.74), gaugeTone(0.75), gaugeTone(0.89), gaugeTone(0.9), gaugeTone(1), gaugeTone(null)]).toEqual(["ok", "ok", "ok", "warn", "warn", "bad", "bad", "none"]);
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

describe("MarketCheck reset times (\"2026-11-01 00:00:00 UTC\" — Safari can't parse it natively)", async () => {
  const { parseMcTime, isoMcTime, summarize, spentKeyIds } = await import("../src/quota.js");
  it("parses MarketCheck's format and ISO alike", () => {
    expect(parseMcTime("2026-11-01 00:00:00 UTC")).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(parseMcTime("2026-11-01T00:00:00Z")).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(Number.isNaN(parseMcTime(""))).toBe(true);
  });
  it("isoMcTime rewrites MarketCheck's format, leaves others alone", () => {
    expect(isoMcTime("2026-11-01 00:00:00 UTC")).toBe("2026-11-01T00:00:00Z");
    expect(isoMcTime("2026-11-01T00:00:00Z")).toBe("2026-11-01T00:00:00Z");
    expect(isoMcTime(null)).toBeNull();
  });
  it("a spent key stored with MarketCheck's format renews once its reset passes", () => {
    const keys = [{ key: "sk-aaaa1111" }];
    const store = { snaps: { "1111": { remaining: 0, limit: 500, exhausted: true, reset: "2026-11-01 00:00:00 UTC" } } };
    expect(spentKeyIds(keys, store, Date.parse("2026-10-20T00:00:00Z"))).toEqual(["1111"]);
    expect(spentKeyIds(keys, store, Date.parse("2026-11-02T00:00:00Z"))).toEqual([]);
    expect(summarize(keys, store, Date.parse("2026-10-20T00:00:00Z")).nextReset).toBe(Date.parse("2026-11-01T00:00:00Z"));
  });
});
