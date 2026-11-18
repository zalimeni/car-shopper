import { describe, it, expect, vi, beforeEach } from "vitest";

// The server reads the caller's MarketCheck keys from the vault (api/_keys.js);
// each request below puts its `marketcheckKeys` there first.
const vault = vi.hoisted(() => ({ keys: [] }));
vi.mock("../api/_keys.js", () => ({ getMarketcheckKeys: async () => vault.keys }));
vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1" } }), safeEqual: () => true, DEFAULT_ALLOW: "" }));
const { default: handler, resolveKeys, setThrottleMs } = await import("../api/marketcheck.js");
setThrottleMs(1); // don't sit through the real 500 ms spacing

const VIN = "KM8JBDD22RU123456";
const rec = (price) => ({ vin: VIN, price: price, msrp: 31000, dealer: { name: "Kia of the Shoals" }, build: { make: "Hyundai", model: "Tucson", year: 2024 }, media: { photo_links_cached: ["https://x/?api_key=SECRETKEY"] } });
const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = (body, query) => { const r = res(); vault.keys = (body && body.marketcheckKeys) || []; return handler({ method: "POST", headers: { authorization: "Bearer t" }, body, query: query || { raw: "1" } }, r).then(() => r); };
const keyOf = (url) => new URL(url).searchParams.get("api_key");

// spec per key: { status, q:{remaining,limit,reset}, retryAfter, body, listings } — or { seq:[spec,...] } consumed in order.
let calls, urls;
function mockFetch(byKey) {
  calls = []; urls = [];
  const idx = {};
  global.fetch = vi.fn(async (url) => {
    const k = keyOf(url); calls.push(k); urls.push(url);
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
  it("uses the configured keys, trimmed and in order, skipping blanks", () => {
    expect(resolveKeys([" A ", "B", "", null], "ENV")).toEqual({ keys: ["A", "B"], shared: false });
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

// Debug raw's VIN lookup (?raw=1 + vin) runs through the same search session as a
// sync step, so it shows the same key policy.
describe("fails over only when the monthly quota is actually spent", () => {
  it("moves to the next key when the first is out of monthly quota (429 + remaining 0)", async () => {
    mockFetch({ K1: SPENT, K2: OK(26683) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
    expect(r.body.notices.join(" ")).toMatch(/Key #1 is out of monthly quota; continuing on key #2/);
    expect(r.body.records[0]).toMatchObject({ price: 26683, appWouldStore: 26683 });
  });
  it("402 always counts as spent", async () => {
    mockFetch({ K1: { status: 402 }, K2: OK(1) });
    await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
  });
  it("recognises a spent key from the body alone when there are no quota headers", async () => {
    mockFetch({ K1: { status: 429, body: "Monthly quota exceeded" }, K2: OK(1) });
    await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1", "K2"]);
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
    expect(r.body.notices).toEqual([]);
    expect(r.body.records[0].price).toBe(26683);
  });
  it("a throttle that won't clear is reported as such; the spare key is left alone", async () => {
    mockFetch({ K1: THROTTLE, K2: OK(999) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls.every((k) => k === "K1")).toBe(true);
    expect(calls.length).toBeGreaterThan(1); // it did back off and retry
    expect(r.body.rateLimited).toBe(true);
    expect(r.body.errors.join(" ")).toMatch(/rate-limiting requests/);
  });
  it("a bare 503 is not a spent quota", async () => {
    mockFetch({ K1: { status: 503 }, K2: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1"]);
    expect(r.body.errors.join(" ")).toMatch(/HTTP 503/);
  });
  it("reports the failure (not a crash) when every configured key is spent", async () => {
    mockFetch({ K1: SPENT, K2: SPENT });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(r.code).toBe(200);
    expect(r.body.rateLimited).toBe(true);
    expect(r.body.errors.join(" ")).toMatch(/monthly quota is used up on all 2 keys/);
  });
  it("starts past a key the caller already knows is spent", async () => {
    mockFetch({ K1: SPENT, K2: OK(1) });
    await call({ vin: VIN, marketcheckKeys: ["K1", "K2"], spentKeys: ["K1"] });
    expect(calls).toEqual(["K2"]);
  });
  it("stays on the first key when it works, and reports its quota like a sync", async () => {
    mockFetch({ K1: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).toEqual(["K1"]);
    expect(r.body.calls).toBe(1);
    expect(r.body.keyQuotas).toEqual([expect.objectContaining({ id: "K1", remaining: 300 })]);
  });
  it("never leaks a key into the response", async () => {
    mockFetch({ K1: OK(1) });
    const body = (await call({ vin: VIN, marketcheckKeys: ["K1"] })).body;
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toMatch(/api_key=K1/);
    expect(body.request).toMatch(/api_key=REDACTED/);
  });
});

describe("keys come from the vault, never the request", () => {
  it("ignores marketcheckKeys sent in the body", async () => {
    process.env.MARKETCHECK_API_KEY = "ENV";
    mockFetch({ ENV: OK(1), INJECTED: OK(2) });
    vault.keys = [];
    const r = res();
    await handler({ method: "POST", headers: { authorization: "Bearer t" }, body: { vin: VIN, marketcheckKeys: ["INJECTED"] }, query: { raw: "1" } }, r);
    expect(calls).toEqual(["ENV"]);
  });
});

describe("the shared server key is not a fallback", () => {
  it("is NOT used even when every configured key is spent", async () => {
    process.env.MARKETCHECK_API_KEY = "ENV";
    mockFetch({ K1: SPENT, K2: SPENT, ENV: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: ["K1", "K2"] });
    expect(calls).not.toContain("ENV");
    expect(r.body.rateLimited).toBe(true);
  });
  it("is used when there are no configured keys at all", async () => {
    process.env.MARKETCHECK_API_KEY = "ENV";
    mockFetch({ ENV: OK(1) });
    const r = await call({ vin: VIN, marketcheckKeys: [] });
    expect(calls).toEqual(["ENV"]);
    expect(r.body.keyQuotas[0].id).toBe("shared");
  });
  it("a configured key identical to it is not counted or called twice", async () => {
    process.env.MARKETCHECK_API_KEY = "SAME";
    mockFetch({ SAME: OK(1) });
    await call({ vin: VIN, marketcheckKeys: ["SAME"] });
    expect(calls).toEqual(["SAME"]);
  });
});

describe("raw sample: one call, the sync's own search", () => {
  const profile = { id: "p", name: "P", params: { make: "Hyundai", model: "Tucson" } };
  it("is page 1 of the profile's full refresh, a couple of rows, salt-belt states left out — and reports quota", async () => {
    mockFetch({ K1: SPENT, K2: OK(26683) });
    const r = await call({ profile: profile, marketcheckKeys: ["K1", "K2"], spentKeys: ["K1"] });
    expect(calls).toEqual(["K2"]);
    const q = new URL(urls[0]).searchParams;
    expect(q.get("rows")).toBe("2");
    expect(q.get("state").split(",")).not.toContain("OH");
    expect(r.body.request).toMatch(/api_key=REDACTED/);
    expect(r.body.rawSample[0].vin).toBe(VIN);
    expect(r.body.rawSample[0].media).toBeUndefined();
    expect(r.body.normalizedSample[0]).toMatchObject({ vin: VIN, price: 26683, profileId: "p" });
    expect(r.body.keyQuotas).toEqual([expect.objectContaining({ id: "K2", remaining: 300 })]);
    expect(r.body.calls).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain("SECRETKEY");
  });
  it("stops after page 1 even when the match set is over the 500-row ceiling", async () => {
    mockFetch({ K1: { status: 200, q: { remaining: 300 }, body: JSON.stringify({ num_found: 4000, listings: [rec(1), rec(2)] }) } });
    const r = await call({ profile: profile, marketcheckKeys: ["K1"] });
    expect(calls).toEqual(["K1"]);
    expect(r.body.numFound).toBe(4000);
  });
  it("keeps every state when salt-belt cars are flagged rather than excluded", async () => {
    mockFetch({ K1: OK(1) });
    await call({ profile: profile, excludeSalt: false, marketcheckKeys: ["K1"] });
    expect(new URL(urls[0]).searchParams.get("state").split(",")).toContain("OH");
  });
  it("needs a profile or a VIN", async () => {
    mockFetch({ K1: OK(1) });
    expect((await call({ marketcheckKeys: ["K1"] })).code).toBe(400);
    expect((await call({ vin: "nope", marketcheckKeys: ["K1"] })).code).toBe(400);
    expect(calls).toEqual([]);
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
