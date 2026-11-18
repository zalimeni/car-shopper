import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const { createSession, runStep, readApiInfo, VALIDATED_VERSION, setThrottleMs } = await import("../api/marketcheck.js");
setThrottleMs(1); // don't sit through the real 500 ms spacing
// One full-refresh step for the first profile (the old searchListings shape).
const searchListings = (key, profiles) => runStep(createSession([key]), { kind: "full", profile: profiles[0] });

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

describe("no API version pin", () => {
  it("sends no x-version header (MarketCheck serves its default), only Accept: JSON", async () => {
    mockFetch(() => ({}));
    await searchListings("K", P, H, {});
    expect(sent.length).toBe(1);
    expect(sent.every((s) => s.headers["x-version"] === undefined && s.headers.Accept === "application/json")).toBe(true);
  });
  it("a 404 or 400 is one billed call — no retry", async () => {
    mockFetch(() => ({ status: 404, body: '{"message":"release not found","code":404}' }));
    expect((await searchListings("K", P, H, {})).calls).toBe(1);
    mockFetch(() => ({ status: 400, body: "bad price_range" }));
    expect((await searchListings("K", P, H, {})).calls).toBe(1);
  });
});

describe("version + lifecycle headers come back with every sync", () => {
  it("readApiInfo reads them, null when absent", () => {
    expect(readApiInfo({ headers: { get: (h) => LIVE[h] ?? null } })).toMatchObject({ served: "v4.8.0", sunset: LIVE.sunset, deprecation: LIVE.deprecation });
    expect(readApiInfo({ headers: { get: () => null } })).toBeNull();
  });
  it("a sync step returns them with the version normalize() was validated against", async () => {
    expect(VALIDATED_VERSION).toBe("v4.8.0");
    mockFetch(() => ({}));
    const r = await searchListings("K", P, H, {});
    expect(r.apiInfo).toMatchObject({ validated: "v4.8.0", served: "v4.8.0", sunset: LIVE.sunset });
    expect(r.apiInfo.pinned).toBeUndefined();
  });
});

describe("format drift guard", () => {
  it("flags a sync where most rows lack VIN/make/model (e.g. renamed fields in a new version)", async () => {
    const rows = Array.from({ length: 12 }, () => ({ id: 1, car: { make: "Kia" }, price: 1 }));
    mockFetch(() => ({ headers: Object.assign({}, LIVE, { "served-by-version": "v5.0.0" }), body: { num_found: 12, listings: rows } }));
    const r = await searchListings("K", P, H, {});
    expect(r.errors[0]).toMatch(/response format looks changed \(12 of 12 rows missing VIN\/make\/model, served by v5\.0\.0\)/);
  });
  it("flags a 200 with no listings array at all", async () => {
    mockFetch(() => ({ body: { results: [] } }));
    expect((await searchListings("K", P, H, {})).errors[0]).toMatch(/format looks changed \(no listings array/);
  });
  it("stays quiet for normal data, a few odd rows, or tiny samples", async () => {
    mockFetch(() => ({ body: { num_found: 20, listings: Array.from({ length: 20 }, (_, i) => (i < 3 ? { vin: "x" + i } : row())) } }));
    expect((await searchListings("K", P, H, {})).errors).toEqual([]);
    mockFetch(() => ({ body: { num_found: 3, listings: [{}, {}, {}] } }));
    expect((await searchListings("K", P, H, {})).errors).toEqual([]);
  });
});
