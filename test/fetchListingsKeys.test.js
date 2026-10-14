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
    expect(bodies.map((b) => b.spentKeys)).toEqual([[], ["1111"], ["1111"]]);
    expect(r.notices).toEqual(["Key #1 is out of monthly quota; continuing on key #2."]);
    expect(r.errors).toEqual([]);
    expect(r.calls).toBe(4);
  });
  it("starts from the spent keys the stored quota already knows", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ listings: [] }) }; });
    await fetchListings([{ id: "p" }], [{ z: "1" }, { z: "2" }], {}, { spentKeys: ["1111"] });
    expect(bodies.map((b) => b.spentKeys)).toEqual([["1111"], ["1111"]]);
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
