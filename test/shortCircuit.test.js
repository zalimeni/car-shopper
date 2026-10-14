import { describe, it, expect, vi } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1";
const { searchListings, searchKey, pageFingerprint, buildUrl } = await import("../api/marketcheck.js");
const { reconcile, searchFpMap, mergeSearchFps } = await import("../src/reconcile.js");

const T0 = 1791700000;
const car = (i, over) => Object.assign({ vin: "VIN" + String(i).padStart(5, "0"), price: 20000 + i, miles: 1000 + i, last_seen_at: T0 - i * 10, dos_active: 5,
  build: { make: "Toyota", model: "RAV4", year: 2021 }, dealer: { name: "D", city: "Durham", state: "NC" } }, over || {});
// A fake MarketCheck: `inv` is the full result set; it serves 50 rows per page sorted by last_seen desc.
let calls;
function serve(inv) {
  calls = [];
  global.fetch = vi.fn(async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams); calls.push(q);
    const sorted = inv.slice().sort((a, b) => b.last_seen_at - a.last_seen_at);
    const start = Number(q.start || 0);
    const text = JSON.stringify({ num_found: inv.length, listings: sorted.slice(start, start + 50) });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
  });
}
const RAV = { id: "rav4", name: "RAV4", params: { make: "Toyota", model: "RAV4" } };
const HUB = [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }];
const inv120 = Array.from({ length: 120 }, (_, i) => car(i));
async function sync(inv, fingerprints, profiles) {
  serve(inv);
  return searchListings("K", profiles || [RAV], HUB, { fingerprints: fingerprints || {} });
}

describe("requests are sorted newest-crawled first", () => {
  it("buildUrl asks for sort_by=last_seen desc", () => {
    const q = new URLSearchParams(buildUrl("K", RAV, HUB[0]).split("?")[1]);
    expect([q.get("sort_by"), q.get("sort_order")]).toEqual(["last_seen", "desc"]);
  });
});

describe("unchanged-search short-circuit", () => {
  it("first sync reads every page and records a fingerprint; cars are tagged with their search", async () => {
    const r = await sync(inv120);
    expect(calls.length).toBe(3);
    const k = searchKey(RAV, HUB[0], "used", null);
    expect(Object.keys(r.fingerprints)).toEqual([k]);
    expect(r.unchanged).toEqual([]);
    expect(r.listings.length).toBe(120);
    expect(r.listings.every((l) => l.mcQ.length === 1 && l.mcQ[0] === k)).toBe(true);
  });
  it("an identical page 1 means the whole set is unchanged: one call, not three", async () => {
    const first = await sync(inv120);
    const r = await sync(inv120, first.fingerprints);
    expect(calls.length).toBe(1);
    expect(r.unchanged).toEqual(Object.keys(first.fingerprints));
    expect(r.fingerprints).toEqual(first.fingerprints);
  });
  it("a re-priced car anywhere (it gets re-crawled, so it rises to page 1) forces a full read", async () => {
    const first = await sync(inv120);
    const later = inv120.map((c, i) => (i === 110 ? car(110, { price: 1, last_seen_at: T0 + 500 }) : c));
    await sync(later, first.fingerprints);
    expect(calls.length).toBe(3);
  });
  it("a car removed from a deep page changes num_found, so it forces a full read too", async () => {
    const first = await sync(inv120);
    await sync(inv120.filter((c, i) => i !== 115), first.fingerprints);
    expect(calls.length).toBe(3);
  });
  it("ignores fields that drift without a real change (days-on-market counters)", async () => {
    const first = await sync(inv120);
    await sync(inv120.map((c) => Object.assign({}, c, { dos_active: 99, dom: 300, dom_active: 98 })), first.fingerprints);
    expect(calls.length).toBe(1);
  });
  it("tied timestamps reshuffling within page 1 don't look like a change (VIN-ordered fingerprint)", () => {
    const rows = [car(1, { last_seen_at: 5 }), car(2, { last_seen_at: 5 }), car(3, { last_seen_at: 5 })];
    expect(pageFingerprint(3, rows)).toBe(pageFingerprint(3, [rows[2], rows[0], rows[1]]));
    expect(pageFingerprint(3, rows)).not.toBe(pageFingerprint(4, rows));
  });
  it("editing a profile is a different search, so it gets a full read", async () => {
    const first = await sync(inv120);
    await sync(inv120, first.fingerprints, [{ id: "rav4", name: "RAV4", params: { make: "Toyota", model: "RAV4", maxMiles: 90000 } }]);
    expect(calls.length).toBe(3);
  });
  it("a search that failed part-way doesn't record a fingerprint (no false 'unchanged' next time)", async () => {
    calls = [];
    let n = 0;
    global.fetch = vi.fn(async (url) => {
      calls.push(url); n++;
      if (n === 2) return { ok: false, status: 500, headers: { get: () => null }, text: async () => "boom", clone: () => ({ text: async () => "boom" }) };
      const text = JSON.stringify({ num_found: 120, listings: inv120.slice(0, 50) });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
    });
    const r = await searchListings("K", [RAV], HUB, {});
    expect(r.fingerprints).toEqual({});
  });
  it("an unchanged merged search that would split skips its per-profile searches too", async () => {
    const a = { id: "a", name: "A", params: { make: "Toyota", model: "RAV4" } };
    const b = { id: "b", name: "B", params: { make: "Toyota", model: "Camry" } };
    const big = Array.from({ length: 450 }, (_, i) => car(i)); // > 400 cap for a 2-profile group -> split
    const first = await sync(big, {}, [a, b]);
    expect(first.splits).toBe(1);
    const fps = first.fingerprints;
    expect(Object.keys(fps).length).toBe(3); // merged + 2 per-profile
    const r = await sync(big, fps, [a, b]);
    expect(calls.length).toBe(1);
    expect(r.unchanged.sort()).toEqual(Object.keys(fps).sort());
  });
});

describe("reconcile leaves an unchanged search's cars alone", () => {
  const T = "2026-10-15";
  it("end to end: second sync costs 1 call and every car is still 'seen', nothing flagged", async () => {
    const first = await sync(inv120);
    const stored = reconcile([], first.listings, "2026-10-14").candidates.map((c) => Object.assign({}, c, { source: "marketcheck", status: "watch" }));
    const second = await sync(inv120, first.fingerprints);
    expect(calls.length).toBe(1);
    expect(second.listings.length).toBe(50); // only page 1 came back
    const rec = reconcile(stored, second.listings, T, { unchangedKeys: second.unchanged });
    expect(rec.summary.notSeen).toBe(0);
    expect(rec.summary.kept).toBe(70);
    expect(rec.listings.every((l) => l.lastSeen === T)).toBe(true);
    expect(rec.listings.some((l) => l.reviewPending)).toBe(false);
    expect(rec.candidates.length).toBe(0);
  });
  const L = (over) => Object.assign({ vin: "A1", price: 100, status: "watch", source: "marketcheck", lastSeen: "2026-10-01", notes: "", mcQ: ["qA"] }, over);
  it("a car from an unchanged search is kept as-is (no price/notes/flags), just seen today", () => {
    const rec = reconcile([L()], [], T, { unchangedKeys: ["qA"] });
    expect(rec.listings[0]).toEqual(Object.assign(L(), { lastSeen: T, lastChecked: T }));
    expect(rec.summary).toMatchObject({ kept: 1, notSeen: 0 });
  });
  it("a car whose search WAS re-read but didn't include it is still 'not seen', as before", () => {
    const rec = reconcile([L()], [], T, { unchangedKeys: ["qOther"] });
    expect(rec.summary.notSeen).toBe(1);
    expect(rec.listings[0].lastSeen).toBe("2026-10-01");
  });
  it("keeps an unchanged search's tag on a car seen elsewhere this sync, drops stale ones", () => {
    const rec = reconcile([L({ mcQ: ["qA", "qB", "qGone"] })], [{ vin: "A1", price: 100, mcQ: ["qA"] }], T, { unchangedKeys: ["qB"] });
    expect(rec.listings[0].mcQ).toEqual(["qA", "qB"]);
  });
  it("listings synced before this feature (no tags) behave exactly as before", () => {
    const rec = reconcile([L({ mcQ: undefined })], [], T, { unchangedKeys: ["qA"] });
    expect(rec.summary.notSeen).toBe(1);
  });
});

describe("fingerprint store", () => {
  it("round-trips, updates, and drops searches unused for 30 days", () => {
    const s1 = mergeSearchFps(null, { q1: "f1", q2: "f2" }, "2026-09-01T00:00:00Z");
    const s2 = mergeSearchFps(s1, { q1: "f1b" }, "2026-10-15T00:00:00Z");
    expect(searchFpMap(s2)).toEqual({ q1: "f1b" }); // q2 last used 44 days ago
    expect(searchFpMap(null)).toEqual({});
  });
});
