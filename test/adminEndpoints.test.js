import { describe, it, expect, vi, beforeEach } from "vitest";

// The destructive / admin endpoints: api/snapshots.js restore (overwrites the
// caller's app_state) and api/allowlist.js's guards against an admin removing
// or demoting themselves. authorize() is stubbed (requireAdmin/deny are real);
// the service-role client is a fake that logs every query.

const h = vi.hoisted(() => ({ auth: null, db: null }));
vi.mock("../api/_auth.js", async (orig) => Object.assign({}, await orig(), { authorize: async () => h.auth }));
vi.mock("../api/_supabaseAdmin.js", () => ({ adminClient: () => h.db, anonClient: () => null }));

const { default: snapshots } = await import("../api/snapshots.js");
const { default: allowlist } = await import("../api/allowlist.js");

const ME = "00000000-0000-0000-0000-0000000000a1";
const asAdmin = () => ({ user: { id: ME, email: "Me@Example.com" }, admin: true, mfa: { enrolled: true, aal: "aal2" } });
const asUser = () => ({ user: { id: ME, email: "me@example.com" }, admin: false, mfa: { enrolled: false, aal: "aal1" } });

// rows: { [table]: answer for a select } — maybeSingle() answers the first row.
function fakeDb(rows) {
  const log = [];
  function from(table) {
    const q = { table: table, op: "select", filters: [], payload: null, single: false };
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; },
      eq(c, v) { q.filters.push([c, v]); return b; },
      maybeSingle() { q.single = true; return b; },
      insert(p) { q.op = "insert"; q.payload = p; return b; },
      update(p) { q.op = "update"; q.payload = p; return b; },
      upsert(p, o) { q.op = "upsert"; q.payload = p; q.opts = o; return b; },
      delete() { q.op = "delete"; return b; },
      then(f, r) {
        log.push(q);
        let data = null;
        if (q.op === "select") {
          const list = (rows[table] || []).filter((row) => q.filters.every(([c, v]) => row[c] === v));
          data = q.single ? list[0] || null : list;
        }
        return Promise.resolve({ data: data, error: null }).then(f, r);
      },
    };
    return b;
  }
  return { log: log, from: from, auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } };
}
const writes = (op, table) => h.db.log.filter((q) => q.op === op && (!table || q.table === table));

const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = (handler, method, body) => { const r = res(); return handler({ method: method, headers: {}, body: body, query: {} }, r).then(() => r); };

describe("POST /api/snapshots { id } — restore", () => {
  const OLD = { version: 11, listings: [{ vin: "OLD" }], settings: { budget: 1 } };
  const CUR = { version: 11, listings: [{ vin: "CUR" }], settings: { budget: 2 } };
  beforeEach(() => {
    h.auth = asUser();
    h.db = fakeDb({
      app_state_history: [{ id: 7, user_id: ME, data: OLD, saved_at: "2026-11-01T00:00:00Z" }, { id: 8, user_id: "someone-else", data: {}, saved_at: "x" }],
      app_state: [{ user_id: ME, data: CUR, rev: 41 }],
    });
  });

  it("snapshots the current state, then overwrites app_state and bumps rev", async () => {
    const r = await call(snapshots, "POST", { id: 7 });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true, restored: "2026-11-01T00:00:00Z" });
    const ins = writes("insert", "app_state_history");
    expect(ins.length).toBe(1);
    expect(ins[0].payload).toEqual({ user_id: ME, data: CUR });
    const up = writes("upsert", "app_state");
    expect(up.length).toBe(1);
    expect(up[0].payload).toMatchObject({ user_id: ME, data: OLD, rev: 42 });
    expect(up[0].opts).toEqual({ onConflict: "user_id" });
    // the undo snapshot is written before the overwrite
    expect(h.db.log.indexOf(ins[0])).toBeLessThan(h.db.log.indexOf(up[0]));
  });
  it("restores at rev 1 when the user has no row yet", async () => {
    h.db = fakeDb({ app_state_history: [{ id: 7, user_id: ME, data: OLD, saved_at: "t" }] });
    await call(snapshots, "POST", { id: 7 });
    expect(writes("insert", "app_state_history")).toEqual([]);
    expect(writes("upsert", "app_state")[0].payload.rev).toBe(1);
  });
  it("only ever looks up the caller's own snapshots", async () => {
    const r = await call(snapshots, "POST", { id: 8 });
    expect(r.code).toBe(404);
    expect(writes("upsert")).toEqual([]);
    expect(writes("insert")).toEqual([]);
  });
  it("needs a snapshot id", async () => {
    const r = await call(snapshots, "POST", {});
    expect(r.code).toBe(400);
    expect(writes("upsert")).toEqual([]);
  });
});

describe("/api/allowlist guards", () => {
  beforeEach(() => { h.auth = asAdmin(); h.db = fakeDb({}); });

  it("an admin can't remove themselves (any letter case)", async () => {
    const r = await call(allowlist, "DELETE", { email: " me@example.COM " });
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/remove yourself/);
    expect(writes("delete")).toEqual([]);
  });
  it("an admin can't demote themselves", async () => {
    const r = await call(allowlist, "PATCH", { email: "me@example.com", is_admin: false });
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/own admin access/);
    expect(writes("update")).toEqual([]);
  });
  it("but can change their own other flags", async () => {
    const r = await call(allowlist, "PATCH", { email: "me@example.com", scheduled_sync: true });
    expect(r.code).toBe(200);
    expect(writes("update")[0].payload).toEqual({ scheduled_sync: true });
  });
  it("removes and demotes someone else", async () => {
    expect((await call(allowlist, "DELETE", { email: "Friend@example.com" })).code).toBe(200);
    expect(writes("delete")[0].filters).toEqual([["email", "friend@example.com"]]);
    expect((await call(allowlist, "PATCH", { email: "friend@example.com", is_admin: false })).code).toBe(200);
    expect(writes("update")[0].payload).toEqual({ is_admin: false });
  });
  it("a non-admin gets 403 and nothing is written", async () => {
    h.auth = asUser();
    const r = await call(allowlist, "DELETE", { email: "friend@example.com" });
    expect(r.code).toBe(403);
    expect(h.db.log).toEqual([]);
  });
  it("an admin without two-factor gets 403", async () => {
    h.auth = Object.assign(asAdmin(), { mfa: { enrolled: false, aal: "aal1" } });
    const r = await call(allowlist, "PATCH", { email: "friend@example.com", is_admin: true });
    expect(r.code).toBe(403);
    expect(r.body.code).toBe("mfa_enroll_required");
    expect(h.db.log).toEqual([]);
  });
});
