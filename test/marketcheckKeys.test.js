import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const handler = (await import("../api/marketcheck.js")).default;

const VIN = "KM8JBDD22RU123456";
const rec = (price) => ({ vin: VIN, price: price, msrp: 31000, dealer: { name: "Kia of the Shoals" }, build: { make: "Hyundai", model: "Tucson", year: 2024 }, media: { photo_links_cached: ["https://x/?api_key=SECRETKEY"] } });
const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = (body, query) => { const r = res(); return handler({ method: "POST", headers: { authorization: "Bearer t" }, body, query: query || { raw: "1" } }, r).then(() => r); };
const keyOf = (url) => new URL(url).searchParams.get("api_key");

let calls;
function mockFetch(byKey) {
  calls = [];
  global.fetch = vi.fn(async (url) => {
    const k = keyOf(url); calls.push(k);
    const spec = byKey[k] || { status: 200, listings: [] };
    return { ok: spec.status === 200, status: spec.status, headers: { get: () => null },
      text: async () => JSON.stringify({ num_found: (spec.listings || []).length, listings: spec.listings || [] }),
      json: async () => ({ num_found: (spec.listings || []).length, listings: spec.listings || [] }) };
  });
}
beforeEach(() => { delete process.env.MARKETCHECK_API_KEY; });

describe("raw/debug VIN lookup rotates keys", () => {
  it("falls over to the next key when the first is out of quota", async () => {
    mockFetch({ K1: { status: 503 }, K2: { status: 200, listings: [rec(26683)] } });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
    expect(r.body).toMatchObject({ status: 200, keyUsed: 2, keysAvailable: 2 });
    expect(r.body.records[0]).toMatchObject({ price: 26683, appWouldStore: 26683 });
  });
  it("uses the shared server key as the last resort", async () => {
    process.env.MARKETCHECK_API_KEY = "ENV";
    mockFetch({ K1: { status: 402 }, ENV: { status: 200, listings: [rec(24688)] } });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1"] });
    expect(calls).toEqual(["K1", "ENV"]);
    expect(r.body.keyUsed).toBe(2);
  });
  it("stays on the first key when it works", async () => {
    mockFetch({ K1: { status: 200, listings: [rec(1)] } });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1"]);
    expect(r.body.keyUsed).toBe(1);
  });
  it("reports the failure (not a crash) when every key is spent", async () => {
    mockFetch({ K1: { status: 503 }, K2: { status: 503 } });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(r.body.status).toBe(503);
    expect(r.body.keyUsed).toBe(2);
  });
  it("never leaks a key into the response", async () => {
    mockFetch({ K1: { status: 200, listings: [rec(1)] } });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1"] });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toMatch(/api_key=K1/);
  });
});

describe("raw sample rotates keys, and keeps using the one that worked for diagnosis", () => {
  it("fails over on the main query and reuses key 2 for the relaxed re-runs", async () => {
    mockFetch({ K1: { status: 503 }, K2: { status: 200, listings: [] } });
    const body = { profiles: [{ id: "p", name: "P", params: { make: "Kia", model: "Telluride" } }], hubs: [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }], marketcheckKeys: ["K1", "K2"] };
    const r = await call(body);
    expect(calls[0]).toBe("K1");
    expect(calls.slice(1).every((k) => k === "K2")).toBe(true);
    expect(calls.length).toBeGreaterThan(2); // main + the diagnosis variants
    expect(r.body.keyUsed).toBe(2);
  });
});

describe("no key anywhere", () => {
  it("still returns the clear error", async () => {
    mockFetch({});
    const r = await call({ vin: VIN, marketcheckKeys: [] });
    expect(r.code).toBe(500);
    expect(r.body.error).toMatch(/No MarketCheck API key/);
  });
});
