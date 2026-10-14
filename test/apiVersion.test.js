import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1";
vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const { searchListings, readApiInfo, API_VERSION } = await import("../api/marketcheck.js");

// Headers MarketCheck actually sent (Oct 2026).
const LIVE = { "served-by-version": "v4.8.0", "requested-from-version": "default", "auto-upgraded-version": "false",
  deprecation: "Fri, 07 Aug 2026 00:00:00 GMT", sunset: "Sun, 28 Feb 2027 23:59:59 GMT" };
let sent;
function mockFetch(respond) {
  sent = [];
  global.fetch = vi.fn(async (url, opts) => {
    sent.push({ url, headers: (opts && opts.headers) || {} });
    const { status = 200, headers = LIVE, body } = respond(opts && opts.headers, sent.length);
    const text = typeof body === "string" ? body : JSON.stringify(body || { num_found: 0, listings: [] });
    return { ok: status === 200, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
  });
}
const P = [{ id: "p", name: "P", params: { make: "Kia", model: "Telluride" } }];
const H = [{ n: "Durham, NC", lat: 36, lon: -78.9 }];
const row = (over) => Object.assign({ vin: "V" + Math.random(), price: 1, miles: 1, build: { make: "Kia", model: "Telluride", year: 2024 } }, over || {});

describe("API version pinning", () => {
  it("pins the version normalize() was validated against, on every request", async () => {
    expect(API_VERSION).toBe("v4.8.0");
    mockFetch(() => ({}));
    await searchListings("K", P, H, {});
    expect(sent.every((s) => s.headers["x-version"] === "v4.8.0" && s.headers.Accept === "application/json")).toBe(true);
  });
  it("if MarketCheck rejects the pin itself, retries unpinned once and reports it — sync keeps working", async () => {
    mockFetch((h) => (h["x-version"] ? { status: 400, body: "Unsupported x-version header value" } : { body: { num_found: 1, listings: [row()] } }));
    const r = await searchListings("K", P, H, {});
    expect(sent.map((s) => !!s.headers["x-version"])).toEqual([true, false]);
    expect(r.listings.length).toBe(1);
    expect(r.apiInfo.pinRejected).toBe(true);
  });
  it("does not drop the pin on an unrelated 400", async () => {
    mockFetch(() => ({ status: 400, body: "bad price_range" }));
    const r = await searchListings("K", P, H, {});
    expect(sent.length).toBe(1);
    expect(r.apiInfo.pinRejected).toBe(false);
  });
});

describe("version + lifecycle headers come back with every sync", () => {
  it("readApiInfo reads them, null when absent", () => {
    expect(readApiInfo({ headers: { get: (h) => LIVE[h] ?? null } })).toMatchObject({ served: "v4.8.0", sunset: LIVE.sunset, deprecation: LIVE.deprecation });
    expect(readApiInfo({ headers: { get: () => null } })).toBeNull();
  });
  it("searchListings returns them with the pinned version", async () => {
    mockFetch(() => ({}));
    const r = await searchListings("K", P, H, {});
    expect(r.apiInfo).toMatchObject({ pinned: "v4.8.0", pinRejected: false, served: "v4.8.0", sunset: LIVE.sunset });
  });
});

describe("format drift guard", () => {
  it("flags a sync where most rows lack VIN/make/model (e.g. renamed fields in a new version)", async () => {
    const rows = Array.from({ length: 12 }, () => ({ id: 1, car: { make: "Kia" }, price: 1 }));
    mockFetch(() => ({ headers: Object.assign({}, LIVE, { "served-by-version": "v5.0.0" }), body: { num_found: 12, listings: rows } }));
    const r = await searchListings("K", P, H, {});
    expect(r.formatSuspect).toBe(true);
    expect(r.errors[0]).toMatch(/response format looks changed \(12 of 12 rows missing VIN\/make\/model, served by v5\.0\.0\)/);
  });
  it("flags a 200 with no listings array at all", async () => {
    mockFetch(() => ({ body: { results: [] } }));
    expect((await searchListings("K", P, H, {})).formatSuspect).toBe(true);
  });
  it("stays quiet for normal data, a few odd rows, or tiny samples", async () => {
    mockFetch(() => ({ body: { num_found: 20, listings: Array.from({ length: 20 }, (_, i) => (i < 3 ? { vin: "x" + i } : row())) } }));
    expect((await searchListings("K", P, H, {})).formatSuspect).toBe(false);
    mockFetch(() => ({ body: { num_found: 3, listings: [{}, {}, {}] } }));
    expect((await searchListings("K", P, H, {})).formatSuspect).toBe(false);
  });
});
