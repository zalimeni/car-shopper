import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1";
vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const { default: handler, resolveKeys } = await import("../api/marketcheck.js");

const VIN = "KM8JBDD22RU123456";
const rec = (price) => ({ vin: VIN, price: price, msrp: 31000, dealer: { name: "Kia of the Shoals" }, build: { make: "Hyundai", model: "Tucson", year: 2024 }, media: { photo_links_cached: ["https://x/?api_key=SECRETKEY"] } });
const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = (body, query) => { const r = res(); return handler({ method: "POST", headers: { authorization: "Bearer t" }, body, query: query || { raw: "1" } }, r).then(() => r); };
const keyOf = (url) => new URL(url).searchParams.get("api_key");

// spec per key: { status, q:{remaining,limit,reset}, retryAfter, body, listings } — or { seq:[spec,...] } consumed in order.
let calls;
function mockFetch(byKey) {
  calls = [];
  const idx = {};
  global.fetch = vi.fn(async (url) => {
    const k = keyOf(url); calls.push(k);
    let spec = byKey[k] || { status: 200 };
    if (spec.seq) { const n = idx[k] || 0; idx[k] = n + 1; spec = spec.seq[Math.min(n, spec.seq.length - 1)]; }
    const hdr = {};
    if (spec.q) { hdr["quota-remaining"] = String(spec.q.remaining); hdr["quota-limit"] = String(spec.q.limit || 500); hdr["quota-reset-time"] = spec.q.reset || "2026-11-01T00:00:00Z"; }
    if (spec.retryAfter != null) hdr["retry-after"] = String(spec.retryAfter);
    const text = spec.body != null ? spec.body : JSON.stringify({ num_found: (spec.listings || []).length, listings: spec.listings || [] });
    const out = { ok: spec.status === 200, status: spec.status, headers: { get: (h) => hdr[h.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) };
    out.clone = () => ({ text: async () => text });
    return out;
  });
}
const SPENT = { status: 429, q: { remaining: 0 } };               // monthly quota gone
const THROTTLE = { status: 429, q: { remaining: 400 }, retryAfter: 0.01 }; // per-second throttle: quota fine
const OK = (price) => ({ status: 200, q: { remaining: 300 }, listings: [rec(price)] });
beforeEach(() => { delete process.env.MARKETCHECK_API_KEY; });

describe("resolveKeys: your list is the whole story; the shared key only when you have none", () => {
  it("uses the configured keys, de-duplicated, in order", () => {
    expect(resolveKeys([" A ", "B", "A", "", null], "ENV")).toEqual({ keys: ["A", "B"], shared: false });
  });
  it("ignores the shared key entirely when a list exists — even a key identical to it is just a configured key", () => {
    expect(resolveKeys(["A"], "ENV")).toEqual({ keys: ["A"], shared: false });
    expect(resolveKeys(["ENV"], "ENV")).toEqual({ keys: ["ENV"], shared: false });
  });
  it("falls back to the shared key only for an empty list", () => {
    expect(resolveKeys([], "ENV")).toEqual({ keys: ["ENV"], shared: true });
    expect(resolveKeys(undefined, "ENV")).toEqual({ keys: ["ENV"], shared: true });
    expect(resolveKeys([], "")).toEqual({ keys: [], shared: false });
  });
});

describe("fails over only when the monthly quota is actually spent", () => {
  it("moves to the next key when the first is out of monthly quota (429 + remaining 0)", async () => {
    mockFetch({ K1: SPENT, K2: OK(26683) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
    expect(r.body).toMatchObject({ status: 200, keyUsed: 2, keysAvailable: 2 });
    expect(r.body.records[0]).toMatchObject({ price: 26683, appWouldStore: 26683 });
  });
  it("402 always counts as spent", async () => {
    mockFetch({ K1: { status: 402 }, K2: OK(1) });
    expect((await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] })).body.keyUsed).toBe(2);
  });
  it("recognises a spent key from the body alone when there are no quota headers", async () => {
    mockFetch({ K1: { status: 429, body: "Monthly quota exceeded" }, K2: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
    expect(r.body.keyUsed).toBe(2);
  });
  it("a Retry-After of hours means 'next month': fail over at once, no backoff retries on the dead key", async () => {
    mockFetch({ K1: { status: 429, retryAfter: 86500 }, K2: OK(1) });
    await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
  });
  it("a momentary throttle is retried on the SAME key and never touches the next one", async () => {
    mockFetch({ K1: { seq: [THROTTLE, OK(26683)] }, K2: OK(999) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K1"]);
    expect(r.body).toMatchObject({ status: 200, keyUsed: 1 });
    expect(r.body.records[0].price).toBe(26683);
  });
  it("a throttle that won't clear is reported as such; the spare key is left alone", async () => {
    mockFetch({ K1: THROTTLE, K2: OK(999) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls.every((k) => k === "K1")).toBe(true);
    expect(calls.length).toBeGreaterThan(1); // it did back off and retry
    expect(r.body).toMatchObject({ status: 429, keyUsed: 1 });
  });
  it("a bare 503 is not a spent quota", async () => {
    mockFetch({ K1: { status: 503 }, K2: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1"]);
    expect(r.body.status).toBe(503);
  });
  it("reports the failure (not a crash) when every configured key is spent", async () => {
    mockFetch({ K1: SPENT, K2: SPENT });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(r.body).toMatchObject({ status: 429, keyUsed: 2 });
  });
  it("stays on the first key when it works", async () => {
    mockFetch({ K1: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1"]);
    expect(r.body.keyUsed).toBe(1);
  });
  it("never leaks a key into the response", async () => {
    mockFetch({ K1: OK(1) });
    const text = JSON.stringify((await call({ vin: VIN, marketcheckKeys: ["K1"] })).body);
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toMatch(/api_key=K1/);
  });
});

describe("the shared server key is not a fallback", () => {
  it("is NOT used even when every configured key is spent", async () => {
    process.env.MARKETCHECK_API_KEY = "ENV";
    mockFetch({ K1: SPENT, K2: SPENT, ENV: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).not.toContain("ENV");
    expect(r.body).toMatchObject({ status: 429, keysAvailable: 2 });
  });
  it("is used when there are no configured keys at all", async () => {
    process.env.MARKETCHECK_API_KEY = "ENV";
    mockFetch({ ENV: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: [] });
    expect(calls).toEqual(["ENV"]);
    expect(r.body.keysAvailable).toBe(1);
  });
  it("a configured key identical to it is not counted or called twice", async () => {
    process.env.MARKETCHECK_API_KEY = "SAME";
    mockFetch({ SAME: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["SAME"] });
    expect(calls).toEqual(["SAME"]);
    expect(r.body.keysAvailable).toBe(1);
  });
  it("a key listed twice is used (and counted) once", async () => {
    mockFetch({ K1: SPENT, K2: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
    expect(r.body.keysAvailable).toBe(2);
  });
});

describe("raw sample: fails over on spent quota and keeps the key that worked for diagnosis", () => {
  it("reuses key 2 for the relaxed re-runs", async () => {
    mockFetch({ K1: SPENT, K2: { status: 200, q: { remaining: 300 }, listings: [] } });
    const body = { profiles: [{ id: "p", name: "P", params: { make: "Kia", model: "Telluride" } }], hubs: [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }], marketcheckKeys: ["K1", "K2"] };
    const r = await call(body);
    expect(calls[0]).toBe("K1");
    expect(calls.slice(1).every((k) => k === "K2")).toBe(true);
    expect(calls.length).toBeGreaterThan(2);
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
