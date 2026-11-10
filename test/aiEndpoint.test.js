import { describe, it, expect, vi, beforeEach } from "vitest";

// api/ai.js — task dispatch, key handling, and that each task sends the same
// model / params the old per-feature endpoints did. Anthropic and the vault
// are mocked; nothing leaves the process.

var sent = [];
var nextReply = null;
var nextError = null;
var keyRow = null;
var markedInvalid = [];

vi.mock("../api/_auth.js", () => ({ authorize: async () => ({ user: { id: "u1", email: "me@example.com" } }) }));
vi.mock("../api/_supabaseAdmin.js", () => ({
  getKeyRow: async () => keyRow,
  setKeyValid: async (id, v) => { markedInvalid.push([id, v]); },
}));
vi.mock("@anthropic-ai/sdk", () => {
  class AuthenticationError extends Error { constructor() { super("bad key"); this.status = 401; } }
  class RateLimitError extends Error {}
  class Anthropic {
    constructor(o) { this.key = o.apiKey; this.messages = { stream: (p) => { sent.push(p); return { finalMessage: async () => { if (nextError) throw nextError; return nextReply; } }; } }; }
  }
  Anthropic.AuthenticationError = AuthenticationError;
  Anthropic.RateLimitError = RateLimitError;
  return { default: Anthropic };
});

process.env.KEY_ENCRYPTION_SECRET = "test-secret-0123456789";
const { encrypt } = await import("../api/_crypto.js");
const handler = (await import("../api/ai.js")).default;

function call(method, body, query) {
  var res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  return handler({ method: method, headers: {}, body: body, query: query || {} }, res).then(() => res);
}
function reply(text, stop) { return { stop_reason: stop || "end_turn", content: [{ type: "text", text: text }] }; }

beforeEach(() => { sent = []; nextReply = null; nextError = null; keyRow = { ciphertext: encrypt("sk-ant-test") }; markedInvalid = []; });

describe("api/ai.js", () => {
  it("GET ?task=prompt returns the default scoring prompt", async () => {
    var r = await call("GET", null, { task: "prompt" });
    expect(r.code).toBe(200);
    expect(typeof r.body.system).toBe("string");
    expect(r.body.guidance.price).toBeTruthy();
  });

  it("rejects an unknown task", async () => {
    expect((await call("POST", { task: "nope" })).code).toBe(400);
    expect((await call("POST", { task: "__proto__" })).code).toBe(400);
  });

  it("answers no_key when the vault has no key", async () => {
    keyRow = null;
    var r = await call("POST", { task: "baseline", profile: { params: { make: "Toyota", model: "RAV4" } } });
    expect(r.code).toBe(400);
    expect(r.body.error).toBe("no_key");
  });

  it("price: plain-text verdict with thinking between_tools", async () => {
    nextReply = reply("  Fair price.  ");
    var r = await call("POST", { task: "price", query: { make: "Toyota", model: "RAV4", askingPrice: 25000 }, comps: [] });
    expect(r.code).toBe(200);
    expect(r.body.assessment).toBe("Fair price.");
    expect(sent[0]).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 1024, thinking: { type: "between_tools" } });
    expect(sent[0].output_config).toBeUndefined();
  });

  it("baseline + suggest: structured output on Sonnet 5.5", async () => {
    nextReply = reply(JSON.stringify({ refMileage: 40000, perThousandMi: 50, tiers: [], default: {} }));
    var b = await call("POST", { task: "baseline", profile: { params: { make: "Toyota", model: "RAV4" } }, listings: [] });
    expect(b.code).toBe(200);
    expect(Array.isArray(b.body.baseline.tiers)).toBe(true);
    expect(sent[0]).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 8000, thinking: { type: "between_tools" }, output_config: { format: { type: "json_schema" } } });

    nextReply = reply(JSON.stringify({ mustHave: [], niceToHave: [], dealbreakers: [], avoidYears: [], trimNotes: [], summary: "ok" }));
    var s = await call("POST", { task: "suggest", profile: { params: { make: "Toyota", model: "RAV4" } }, market: {} });
    expect(s.code).toBe(200);
    expect(s.body.suggestion.summary).toBe("ok");
    expect(sent[1]).toMatchObject({ max_tokens: 4000, thinking: { type: "between_tools" } });
  });

  it("score: per-listing results on the chosen model, no thinking param", async () => {
    nextReply = reply(JSON.stringify({ criteria: { price: { score: 8, rationale: "good" } }, summary: "solid" }));
    var r = await call("POST", { task: "score", listings: [{ vin: "V1" }], criteria: [{ id: "price", weight: 1 }], model: "claude-haiku-5-5" });
    expect(r.code).toBe(200);
    expect(r.body.results[0]).toMatchObject({ index: 0, vin: "V1", ok: true });
    expect(sent[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 8000 });
    expect(sent[0].thinking).toBeUndefined();
  });

  it("a rejected key marks it invalid and answers key_rejected", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    nextError = new Anthropic.AuthenticationError();
    var r = await call("POST", { task: "suggest", profile: { params: { make: "Toyota", model: "RAV4" } } });
    expect(r.code).toBe(401);
    expect(r.body.error).toBe("key_rejected");
    expect(markedInvalid).toEqual([["u1", false]]);
  });

  it("a JSON answer cut off at max_tokens is an error", async () => {
    nextReply = reply("{\"tiers\":", "max_tokens");
    var r = await call("POST", { task: "baseline", profile: { params: { make: "Toyota", model: "RAV4" } } });
    expect(r.code).toBe(502);
    expect(r.body.error).toMatch(/token limit/);
  });
});
