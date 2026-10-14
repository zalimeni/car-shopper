import { describe, it, expect, vi } from "vitest";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } }));
const { fetchListings } = await import("../src/sync.js");
const { spentKeyIds } = await import("../src/quota.js");

// One request per location: once a location reports key #1 spent, the rest must
// start on key #2 — not each pay a call to rediscover it (and each log an "error").
describe("fetchListings carries spent keys across its per-location requests", () => {
  it("sends spent ids forward and reports the failover once", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => {
      const b = JSON.parse(init.body); bodies.push(b);
      const first = bodies.length === 1;
      const json = {
        listings: [], errors: [], calls: first ? 2 : 1,
        notices: first ? ["Key #1 is out of monthly quota; continuing on key #2."] : [],
        keyQuotas: first ? [{ id: "1111", remaining: 0, exhausted: true }, { id: "2222", remaining: 300 }] : [{ id: "2222", remaining: 299 }],
      };
      return { ok: true, status: 200, json: async () => json };
    });
    const hubs = [{ n: "A", z: "1" }, { n: "B", z: "2" }, { n: "C", z: "3" }];
    const r = await fetchListings([{ id: "p" }], hubs, {}, { marketcheckKeys: ["xxxx1111", "yyyy2222"], spentKeys: [] });
    // The nationwide attempt first (all hubs), then each location.
    expect(bodies.map((b) => [b.national || null, b.hubs.length])).toEqual([["only", 3], [null, 1], [null, 1], [null, 1]]);
    expect(bodies.map((b) => b.spentKeys)).toEqual([[], ["1111"], ["1111"], ["1111"]]);
    expect(r.notices).toEqual(["Key #1 is out of monthly quota; continuing on key #2."]);
    expect(r.errors).toEqual([]);
    expect(r.calls).toBe(5);
  });
  it("starts from the spent keys the stored quota already knows", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ listings: [] }) }; });
    await fetchListings([{ id: "p" }], [{ z: "1" }, { z: "2" }], {}, { spentKeys: ["1111"] });
    expect(bodies.map((b) => b.spentKeys)).toEqual([["1111"], ["1111"], ["1111"]]);
  });
});

describe("fetchListings: nationwide first", () => {
  it("stops after the nationwide request when it covered every profile", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ listings: [{ vin: "V1", price: 1 }], localProfiles: [], calls: 3 }) }; });
    const r = await fetchListings([{ id: "a" }, { id: "b" }], [{ z: "1" }, { z: "2" }], {}, {});
    expect(bodies.length).toBe(1);
    expect(r.calls).toBe(3);
    expect(r.listings.map((l) => l.vin)).toEqual(["V1"]);
  });
  it("runs only the uncovered profiles per location", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return { ok: true, status: 200, json: async () => ({ listings: [], localProfiles: b.national ? ["b"] : [] }) }; });
    await fetchListings([{ id: "a" }, { id: "b" }], [{ z: "1" }, { z: "2" }], {}, {});
    expect(bodies.map((b) => b.profiles.map((p) => p.id))).toEqual([["a", "b"], ["b"], ["b"]]);
  });
  it("falls back to every location if the nationwide request itself fails", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return b.national ? { ok: false, status: 504, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ listings: [] }) }; });
    const r = await fetchListings([{ id: "a" }], [{ z: "1" }, { z: "2" }], {}, {});
    expect(bodies.length).toBe(3);
    expect(r.errors).toEqual([]); // recovered — every location was searched
    expect(r.notices[0]).toMatch(/Nationwide search failed \(Sync failed \(HTTP 504\)\); searched each location instead/);
  });
  it("a network-level failure ('Load failed') falls back the same way", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); if (b.national) throw new TypeError("Load failed"); return { ok: true, status: 200, json: async () => ({ listings: [] }) }; });
    const r = await fetchListings([{ id: "a" }], [{ z: "1" }, { z: "2" }], {}, {});
    expect(bodies.length).toBe(3);
    expect(r.errors).toEqual([]);
  });
  it("reports progress as nationwide first, then per location only for what's left", async () => {
    const seen = [];
    global.fetch = vi.fn(async (url, init) => { const b = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ listings: [], localProfiles: b.national ? ["b"] : [] }) }; });
    await fetchListings([{ id: "a" }, { id: "b" }], [{ z: "1" }, { z: "2" }], {}, {}, (i) => seen.push([i.phase, i.done, i.total, i.covered]));
    expect(seen).toEqual([["national", 0, 2, null], ["local", 0, 2, 1], ["local", 1, 2, 1], ["local", 2, 2, 1]]);
  });
  it("when nationwide covers everything, progress ends there", async () => {
    const seen = [];
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ listings: [], localProfiles: [] }) }));
    await fetchListings([{ id: "a" }], [{ z: "1" }, { z: "2" }], {}, {}, (i) => seen.push(i.phase));
    expect(seen).toEqual(["national", "done"]);
  });
});

describe("spentKeyIds", () => {
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const keys = [{ key: "xxxx1111" }, { key: "yyyy2222" }];
  it("lists keys whose snapshot is spent and not yet reset", () => {
    const store = { snaps: { "1111": { remaining: 0, limit: 500, exhausted: true, reset: "2026-11-01T00:00:00Z" }, "2222": { remaining: 40, limit: 500, reset: "2026-11-01T00:00:00Z" } } };
    expect(spentKeyIds(keys, store, NOW)).toEqual(["1111"]);
  });
  it("forgets a spent key once its reset time has passed", () => {
    const store = { snaps: { "1111": { remaining: 0, limit: 500, exhausted: true, reset: "2026-10-01T00:00:00Z" } } };
    expect(spentKeyIds(keys, store, NOW)).toEqual([]);
  });
  it("is empty with nothing stored", () => {
    expect(spentKeyIds(keys, null, NOW)).toEqual([]);
  });
});
