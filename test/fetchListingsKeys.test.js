import { describe, it, expect, vi } from "vitest";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } }));
const { fetchListings } = await import("../src/sync.js");
const { spentKeyIds } = await import("../src/quota.js");

const P = (id) => ({ id, name: id, params: { make: "M", model: id } });
const ok = (json) => ({ ok: true, status: 200, json: async () => json });

// One request per step: once a step reports key #1 spent, later steps must start on
// key #2 — not each pay a call to rediscover it.
describe("fetchListings runs the planned steps, one request each", () => {
  it("sends each step's kind, profile and filters", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); return ok({ listings: [] }); });
    await fetchListings([{ kind: "full", profile: P("a") }, { kind: "new", profile: P("b"), since: 2 }], [], {}, { excludeSalt: true, franchiseOnly: true });
    expect(bodies.map((b) => [b.kind, b.profile.id, b.since || null, b.excludeSalt, b.franchiseOnly])).toEqual([["full", "a", null, true, true], ["new", "b", 2, true, true]]);
  });
  it("carries spent keys forward and reports a failover once", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => {
      const b = JSON.parse(init.body); bodies.push(b);
      const first = bodies.length === 1;
      return ok({
        listings: [], errors: [], calls: first ? 2 : 1,
        notices: first ? ["Key #1 is out of monthly quota; continuing on key #2."] : [],
        keyQuotas: first ? [{ id: "1111", remaining: 0, exhausted: true }, { id: "2222", remaining: 300 }] : [{ id: "2222", remaining: 299 }],
      });
    });
    const r = await fetchListings([{ kind: "full", profile: P("a") }, { kind: "full", profile: P("b") }], [], {}, { marketcheckKeys: ["xxxx1111", "yyyy2222"], spentKeys: [] });
    expect(bodies.map((b) => b.spentKeys)).toEqual([[], ["1111"]]);
    expect(r.notices).toEqual(["Key #1 is out of monthly quota; continuing on key #2."]);
    expect(r.errors).toEqual([]);
    expect(r.calls).toBe(3);
  });
  it("looks up watchlist VINs the searches didn't return, and marks unreturned ones gone", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => {
      const b = JSON.parse(init.body); bodies.push(b);
      if (b.kind === "vins") return ok({ listings: [{ vin: "W2", price: 10 }] });
      return ok({ listings: [{ vin: "W1", price: 5 }, { vin: "NEW", price: 7 }], numFound: 2 });
    });
    const r = await fetchListings([{ kind: "new", profile: P("a"), since: 2 }], ["W1", "W2", "W3"], {}, {});
    expect(bodies.map((b) => b.kind)).toEqual(["new", "vins"]);
    expect(bodies[1].vins).toEqual(["W2", "W3"]);
    expect(r.goneVins).toEqual(["W3"]);
    expect(r.listings.map((l) => l.vin).sort()).toEqual(["NEW", "W1", "W2"]);
    expect(r.results[0]).toMatchObject({ kind: "new", numFound: 2, ok: true });
  });
  it("a failed VIN lookup proves nothing gone", async () => {
    global.fetch = vi.fn(async (url, init) => (JSON.parse(init.body).kind === "vins" ? { ok: false, status: 504, json: async () => ({}) } : ok({ listings: [] })));
    const r = await fetchListings([{ kind: "full", profile: P("a") }], ["W1"], {}, {});
    expect(r.goneVins).toEqual([]);
    expect(r.errors[0]).toMatch(/HTTP 504/);
  });
  it("stops on a rate limit — no further steps, no VIN lookup", async () => {
    const bodies = [];
    global.fetch = vi.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: false, status: 429, json: async () => ({}) }; });
    const r = await fetchListings([{ kind: "full", profile: P("a") }, { kind: "full", profile: P("b") }], ["W1"], {}, {});
    expect(bodies.length).toBe(1);
    expect(r.rateLimited).toBe(true);
    expect(r.results[0].ok).toBe(false);
  });
  it("reports progress per step", async () => {
    const seen = [];
    global.fetch = vi.fn(async () => ok({ listings: [] }));
    await fetchListings([{ kind: "full", profile: P("a") }, { kind: "full", profile: P("b") }], [], {}, {}, (i) => seen.push([i.done, i.total, i.label]));
    expect(seen).toEqual([[1, 3, "a"], [2, 3, "b"]]);
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
