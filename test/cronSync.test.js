import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// api/cron-sync.js: auth, which accounts a request syncs (one named account from
// the database dispatcher, or the daily run's fallback), and the bookkeeping
// it writes. The Supabase client is a fake that logs every query; the test
// accounts have no active profiles, so no MarketCheck call is ever made.

const h = vi.hoisted(() => ({ db: null, photoSweeps: 0 }));
vi.mock("../api/_supabaseAdmin.js", () => ({ adminClient: () => h.db, anonClient: () => null }));
vi.mock("../api/_keys.js", () => ({
  getMarketcheckKeys: async () => [],
}));
vi.mock("../api/_photos.js", () => ({
  sweepOrphanPhotos: async () => { h.photoSweeps++; return { removed: 0 }; },
}));
const { default: handler, targetEmail, isDue, resultText, DUE_MS } = await import("../api/cron-sync.js");

const SECRET = "test-cron-secret-0123456789";
const HOUR = 3600 * 1000;

function fakeDb(opts) {
  const log = [];
  function from(table) {
    const q = { table: table, op: "select", filters: [], patch: null };
    const b = {
      select(cols) { if (q.op !== "update") q.cols = cols; return b; },
      update(p) { q.op = "update"; q.patch = p; return b; },
      eq(c, v) { q.filters.push(["eq", c, v]); return b; },
      in(c, v) { q.filters.push(["in", c, v]); return b; },
      maybeSingle() { return b; },
      then(f, r) {
        log.push(q);
        let out = { data: [], error: null };
        if (q.op === "select" && table === "allowed_emails") out = { data: opts.rows, error: null };
        if (q.op === "select" && table === "app_state") {
          const id = (q.filters.find(function (x) { return x[1] === "user_id"; }) || [])[2];
          out = { data: { data: { profiles: [], rev: 1 }, rev: 1, _id: id }, error: null };
        }
        return Promise.resolve(out).then(f, r);
      },
    };
    return b;
  }
  return {
    log: log,
    from: from,
    rpc: async function (name) { log.push({ rpc: name }); return { data: !!opts.ready, error: null }; },
    auth: { admin: { listUsers: async function () { return { data: { users: opts.users || [] }, error: null }; } } },
  };
}

const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = (req) => { const r = res(); return handler(Object.assign({ headers: { authorization: "Bearer " + SECRET }, query: {} }, req), r).then(() => r); };
const updates = () => h.db.log.filter(function (q) { return q.table === "allowed_emails" && q.op === "update"; });
const synced = () => h.db.log.filter(function (q) { return q.table === "app_state" && q.cols === "data,rev"; }).map(function (q) { return q.filters[0][2]; });

const users = [
  { id: "u-never", email: "never@example.com" },
  { id: "u-recent", email: "recent@example.com" },
  { id: "u-stale", email: "Stale@Example.com" },
];
const rows = () => [
  { email: "never@example.com", scheduled_sync: true, last_scheduled_sync: null },
  { email: "recent@example.com", scheduled_sync: true, last_scheduled_sync: new Date(Date.now() - HOUR).toISOString() },
  { email: "stale@example.com", scheduled_sync: true, last_scheduled_sync: new Date(Date.now() - 48 * HOUR).toISOString() },
];

beforeEach(() => { process.env.CRON_SECRET = SECRET; h.photoSweeps = 0; h.db = fakeDb({ rows: rows(), users: users }); });
afterEach(() => { delete process.env.CRON_SECRET; });

describe("request parsing", () => {
  it("reads the account from a JSON body, a string body or ?email=", () => {
    expect(targetEmail({ body: { email: " Me@Example.com " } })).toBe("me@example.com");
    expect(targetEmail({ body: '{"email":"a@b.c"}' })).toBe("a@b.c");
    expect(targetEmail({ body: {}, query: { email: "q@b.c" } })).toBe("q@b.c");
    expect(targetEmail({ body: "not json", query: {} })).toBe("");
    expect(targetEmail({ body: { email: 42 } })).toBe("");
    expect(targetEmail({})).toBe("");
  });
  it("isDue: never synced, or longer ago than DUE_MS", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(isDue({ last_scheduled_sync: null }, now)).toBe(true);
    expect(isDue({}, now)).toBe(true);
    expect(isDue({ last_scheduled_sync: new Date(now - DUE_MS - 1000).toISOString() }, now)).toBe(true);
    expect(isDue({ last_scheduled_sync: new Date(now - HOUR).toISOString() }, now)).toBe(false);
  });
  it("resultText is one short line", () => {
    expect(resultText(null)).toMatch(/^skipped: no signed-up account/);
    expect(resultText({ error: "boom" })).toBe("error: boom");
    expect(resultText({ skipped: "no active profiles" })).toBe("skipped: no active profiles");
    expect(resultText({ parkedCandidates: 3, summary: { priceUpdates: 2 }, queryErrors: ["HTTP 429"] })).toBe("ok: 3 new to review, 2 price changes; query errors: HTTP 429");
    expect(resultText({ error: "x".repeat(1000) }).length).toBe(300);
  });
});

describe("auth", () => {
  it("rejects a missing or wrong secret", async () => {
    expect((await call({ headers: {} })).code).toBe(401);
    expect((await call({ headers: { authorization: "Bearer nope" }, body: { email: "never@example.com" } })).code).toBe(401);
    expect(synced()).toEqual([]);
  });
  it("is a clean no-op without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    const r = await call({ body: { email: "never@example.com" } });
    expect(r.code).toBe(200);
    expect(r.body.disabled).toBe(true);
    expect(synced()).toEqual([]);
  });
});

describe("one account (the database dispatcher)", () => {
  it("syncs just that account, stamps it on attempt and records the outcome", async () => {
    const r = await call({ method: "POST", body: { email: "Stale@example.com" } });
    expect(r.code).toBe(200);
    expect(r.body.mode).toBe("account");
    expect(synced()).toEqual(["u-stale"]);
    expect(h.photoSweeps).toBe(0); // maintenance is the daily run's job
    const u = updates();
    expect(u[0].patch.last_scheduled_sync_result).toBe("started");
    expect(u[0].filters).toEqual([["in", "email", ["stale@example.com"]]]);
    expect(u[u.length - 1].patch).toEqual({ last_scheduled_sync_result: "skipped: no active profiles" });
  });
  it("runs even when the account was synced recently (the dispatcher decides)", async () => {
    await call({ method: "POST", body: { email: "recent@example.com" } });
    expect(synced()).toEqual(["u-recent"]);
  });
  it("does nothing for an account without Daily sync", async () => {
    const r = await call({ method: "POST", body: { email: "someone@example.com" } });
    expect(r.code).toBe(200);
    expect(r.body.skipped).toMatch(/not on/);
    expect(synced()).toEqual([]);
    expect(updates()).toEqual([]);
  });
});

describe("the daily Vercel run", () => {
  it("only does maintenance when the dispatcher is in charge", async () => {
    h.db = fakeDb({ rows: rows(), users: users, ready: true });
    const r = await call({});
    expect(r.code).toBe(200);
    expect(r.body.dispatcher).toBe(true);
    expect(h.photoSweeps).toBe(1);
    expect(synced()).toEqual([]);
    expect(updates()).toEqual([]);
  });
  it("otherwise syncs only the accounts not attempted in the last day", async () => {
    const r = await call({});
    expect(r.body.mode).toBe("fallback");
    expect(h.photoSweeps).toBe(1);
    expect(synced()).toEqual(["u-never", "u-stale"]);
    expect(updates()[0].filters).toEqual([["in", "email", ["never@example.com", "stale@example.com"]]]);
  });
});
