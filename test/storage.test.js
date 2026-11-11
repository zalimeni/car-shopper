import { describe, it, expect, vi, beforeEach } from "vitest";

// storage.js over a fake Supabase client: set() is one save_app_state() call,
// and watchState() subscribes to this user's app_state row.
var rpcAnswer, rpcCalls, handlers, removed;
vi.mock("../src/demoRuntime", () => ({ DEMO: false, loadDemo: async () => null }));
vi.mock("../src/supabaseClient", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    rpc: async (name, args) => { rpcCalls.push([name, args]); return rpcAnswer; },
    channel: (name) => {
      var ch = {
        name: name,
        on: (type, filter, cb) => { handlers.push({ type, filter, cb }); return ch; },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: (ch) => { removed.push(ch.name); },
  },
}));
const { default: storage, watchState } = await import("../src/storage.js");

beforeEach(() => { rpcCalls = []; handlers = []; removed = []; });

describe("storage.set", () => {
  it("sends the data and expected rev to save_app_state", async () => {
    rpcAnswer = { data: { ok: true, rev: 8 }, error: null };
    const r = await storage.set("k", JSON.stringify({ a: 1 }), 7);
    expect(rpcCalls).toEqual([["save_app_state", { p_data: { a: 1 }, p_expected_rev: 7 }]]);
    expect(r).toEqual({ key: "k", value: '{"a":1}', rev: 8 });
  });
  it("passes a null rev through for an unconditional write", async () => {
    rpcAnswer = { data: { ok: true, rev: 1 }, error: null };
    await storage.set("k", "{}", null);
    expect(rpcCalls[0][1].p_expected_rev).toBe(null);
  });
  it("reports a conflict with the stored state", async () => {
    rpcAnswer = { data: { ok: false, rev: 12, data: { b: 2 } }, error: null };
    expect(await storage.set("k", "{}", 7)).toEqual({ conflict: true, key: "k", value: '{"b":2}', rev: 12 });
  });
  it("returns null on an error", async () => {
    rpcAnswer = { data: null, error: { message: "denied", code: "42501" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await storage.set("k", "{}", 7)).toBe(null);
  });
});

describe("watchState", () => {
  it("listens to this user's row and reports the new rev", async () => {
    const seen = [];
    const stop = await watchState((rev) => seen.push(rev));
    expect(handlers[0].filter).toEqual({ event: "UPDATE", schema: "public", table: "app_state", filter: "user_id=eq.u1" });
    handlers[0].cb({ new: { rev: 5 } });
    handlers[0].cb({ new: {} });
    expect(seen).toEqual([5, null]);
    stop();
    expect(removed).toEqual(["app_state:u1"]);
  });
});
