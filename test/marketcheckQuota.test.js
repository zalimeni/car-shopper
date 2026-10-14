import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1"; // read at import; don't sit through the real 500ms spacing
vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const { default: handler, readQuota, keyId } = await import("../api/marketcheck.js");

const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const post = (h, body, query) => { const r = res(); return h({ method: "POST", headers: { authorization: "Bearer t" }, body, query: query || {} }, r).then(() => r); };
const keyOf = (url) => new URL(url).searchParams.get("api_key");

let calls;
// spec per key: { status, q: {remaining, limit, reset}, body }
function mockFetch(byKey) {
  calls = [];
  global.fetch = vi.fn(async (url) => {
    const k = keyOf(url); calls.push(k);
    const spec = byKey[k] || { status: 200 };
    const hdr = {};
    if (spec.q) { hdr["quota-remaining"] = String(spec.q.remaining); hdr["quota-limit"] = String(spec.q.limit); hdr["quota-reset-time"] = spec.q.reset; }
    const text = spec.body != null ? spec.body : JSON.stringify({ num_found: 0, listings: [] });
    return { ok: spec.status === 200, status: spec.status, headers: { get: (h) => hdr[h.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) };
  });
}
const SYNC = { profiles: [{ id: "p", name: "P", params: { make: "Kia", model: "Telluride" } }], hubs: [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }] };
beforeEach(() => { delete process.env.MARKETCHECK_API_KEY; });

describe("readQuota", () => {
  const r = (status, h) => ({ status, headers: { get: (k) => h[k] ?? null } });
  it("reads the monthly counters", () => {
    expect(readQuota(r(200, { "quota-remaining": "412", "quota-limit": "500", "quota-reset-time": "2026-11-01T00:00:00Z" }), "")).toEqual({ remaining: 412, limit: 500, reset: "2026-11-01T00:00:00Z", exhausted: false });
  });
  it("a 429 with calls still left is a per-second throttle, not a spent key", () => {
    expect(readQuota(r(429, { "quota-remaining": "412", "quota-limit": "500" }), "API rate limit exceeded").exhausted).toBe(false);
  });
  it("a 429 at zero remaining, or whose body names the monthly quota, is spent", () => {
    expect(readQuota(r(429, { "quota-remaining": "0", "quota-limit": "500" }), "").exhausted).toBe(true);
    expect(readQuota(r(429, {}), "Monthly quota exceeded").exhausted).toBe(true);
    expect(readQuota(r(429, {}), "Monthly quota exceeded").remaining).toBe(0);
  });
  it("returns null when there is nothing to read", () => { expect(readQuota(r(200, {}), "")).toBeNull(); });
  it("labels the shared key and abbreviates the rest", () => {
    expect(keyId("abcd1234", "abcd1234")).toBe("shared");
    expect(keyId("abcd1234", "other")).toBe("1234");
  });
});

describe("sync reports per-key quota and the real call count", () => {
  it("returns each key's counters and counts every request sent", async () => {
    mockFetch({ AAAA1111: { status: 200, q: { remaining: 480, limit: 500, reset: "2026-11-01T00:00:00Z" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111"] }, SYNC));
    expect(r.body.calls).toBe(2); // used + certified, one page each
    expect(r.body.keyQuotas).toEqual([{ id: "1111", remaining: 480, limit: 500, reset: "2026-11-01T00:00:00Z", exhausted: false }]);
  });
  it("records the spent key as exhausted and the next key's counters", async () => {
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 0, limit: 500, reset: "2026-11-01T00:00:00Z" } }, BBBB2222: { status: 200, q: { remaining: 300, limit: 500, reset: "2026-11-05T00:00:00Z" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111", "BBBB2222"] }, SYNC));
    const byId = Object.fromEntries(r.body.keyQuotas.map((q) => [q.id, q]));
    expect(byId["1111"]).toMatchObject({ exhausted: true, remaining: 0 });
    expect(byId["2222"]).toMatchObject({ exhausted: false, remaining: 300 });
    expect(r.body.keysUsed).toBe(2);
  });
  it("tags the shared server key as 'shared'", async () => {
    process.env.MARKETCHECK_API_KEY = "ENVKEY99";
    mockFetch({ ENVKEY99: { status: 200, q: { remaining: 50, limit: 100, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: [] }, SYNC));
    expect(r.body.keyQuotas[0].id).toBe("shared");
  });
});
