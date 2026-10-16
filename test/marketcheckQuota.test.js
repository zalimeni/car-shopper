import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1"; // read at import; don't sit through the real 500ms spacing
vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const { default: handler, readQuota, keyId } = await import("../api/marketcheck.js");
const { default: compsHandler } = await import("../api/pricecomps.js");

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
    if (spec.retryAfter != null) hdr["retry-after"] = String(spec.retryAfter);
    const text = spec.body != null ? spec.body : JSON.stringify({ num_found: 0, listings: [] });
    return { ok: spec.status === 200, status: spec.status, headers: { get: (h) => hdr[h.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
  });
}
// One sync step as the browser sends it: a profile's full refresh.
const SYNC = { kind: "full", profile: { id: "p", name: "P", params: { make: "Kia", model: "Telluride" } } };
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
    expect(r.body.calls).toBe(1); // one used query (it includes certified), one page
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

describe("sync: a throttle is not a spent key", () => {
  it("backs off and stops on the same key — the spare is never touched — and says it's a rate limit", async () => {
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 400, limit: 500, reset: "R" }, retryAfter: 0.01 }, BBBB2222: { status: 200, q: { remaining: 300, limit: 500, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111", "BBBB2222"] }, SYNC));
    expect(calls.every((k) => k === "AAAA1111")).toBe(true);
    expect(r.body.rateLimited).toBe(true);
    expect(r.body.errors.join(" ")).toMatch(/rate-limiting requests/);
    expect(r.body.errors.join(" ")).not.toMatch(/monthly quota is used up/);
    expect(r.body.keyQuotas.find((q) => q.id === "1111").exhausted).toBe(false);
  });
  it("a genuinely spent key hands over to the next, and the notice says why", async () => {
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } }, BBBB2222: { status: 200, q: { remaining: 300, limit: 500, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111", "BBBB2222"] }, SYNC));
    expect(r.body.rateLimited).toBe(false);
    expect(r.body.keysUsed).toBe(2);
    expect(r.body.notices.join(" ")).toMatch(/Key #1 is out of monthly quota; continuing on key #2/);
    expect(r.body.errors).toEqual([]); // a failover is not a query error
  });
  it("starts past keys the caller already knows are spent — no call wasted rediscovering them", async () => {
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } }, BBBB2222: { status: 200, q: { remaining: 300, limit: 500, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111", "BBBB2222"], spentKeys: ["1111"] }, SYNC));
    expect(calls.every((k) => k === "BBBB2222")).toBe(true);
    expect(r.body.notices).toEqual([]);
    expect(r.body.keysUsed).toBe(2);
  });
  it("if every key is known spent it still tries the last one (once), not none", async () => {
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } }, BBBB2222: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111", "BBBB2222"], spentKeys: ["1111", "2222"] }, SYNC));
    expect(calls).toEqual(["BBBB2222"]);
    expect(r.body.rateLimited).toBe(true);
  });
  it("when every configured key is spent it stops — it does NOT reach for the shared key", async () => {
    process.env.MARKETCHECK_API_KEY = "ENVKEY99";
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } }, BBBB2222: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } }, ENVKEY99: { status: 200, q: { remaining: 90, limit: 100, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["AAAA1111", "BBBB2222"] }, SYNC));
    expect(calls).not.toContain("ENVKEY99");
    expect(r.body.rateLimited).toBe(true);
    expect(r.body.errors.join(" ")).toMatch(/monthly quota is used up on all 2 keys/);
    expect(r.body.keyQuotas.map((q) => q.id).sort()).toEqual(["1111", "2222"]); // no "shared" in the report
  });
  it("with a configured list, a key that happens to equal the shared one is labelled by its tail, not 'shared'", async () => {
    process.env.MARKETCHECK_API_KEY = "SAMEKEY1";
    mockFetch({ SAMEKEY1: { status: 200, q: { remaining: 50, limit: 100, reset: "R" } } });
    const r = await post(handler, Object.assign({ marketcheckKeys: ["SAMEKEY1"] }, SYNC));
    expect(r.body.keyQuotas.map((q) => q.id)).toEqual(["KEY1"]);
  });
});

describe("Price Check live search follows the same key policy", () => {
  const body = { query: { make: "Kia", model: "Telluride", year: 2024 }, hubs: [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }] };
  it("uses only the configured keys and ignores the shared one when they're spent", async () => {
    process.env.MARKETCHECK_API_KEY = "ENVKEY99";
    mockFetch({ AAAA1111: { status: 429, q: { remaining: 0, limit: 500, reset: "R" } }, ENVKEY99: { status: 200, q: { remaining: 90, limit: 100, reset: "R" } } });
    const r = await post(compsHandler, Object.assign({ marketcheckKeys: ["AAAA1111"] }, body));
    expect(calls).not.toContain("ENVKEY99");
    expect(r.body.rateLimited).toBe(true);
  });
  it("falls to the shared key only with no configured keys", async () => {
    process.env.MARKETCHECK_API_KEY = "ENVKEY99";
    mockFetch({ ENVKEY99: { status: 200, q: { remaining: 90, limit: 100, reset: "R" } } });
    const r = await post(compsHandler, Object.assign({ marketcheckKeys: [] }, body));
    expect(new Set(calls)).toEqual(new Set(["ENVKEY99"]));
    expect(r.body.keyQuotas[0].id).toBe("shared");
  });
});

describe("reset times are stored as ISO", () => {
  it("readQuota rewrites MarketCheck's 'YYYY-MM-DD HH:MM:SS UTC'", () => {
    const r = { status: 200, headers: { get: (k) => ({ "quota-remaining": "145", "quota-limit": "500", "quota-reset-time": "2026-11-01 00:00:00 UTC" })[k] ?? null } };
    expect(readQuota(r, "").reset).toBe("2026-11-01T00:00:00Z");
  });
});
