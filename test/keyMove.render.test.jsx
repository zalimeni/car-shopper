// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, waitFor } from "@testing-library/react";

// A blob saved before the key vault still has plaintext MarketCheck keys in
// settings. On load the app hands them to the server, and drops the blob's copy
// only after the server confirms.
const VERSION = 10;
const state = {
  version: VERSION, onboarded: true,
  profiles: [{ id: "p1", name: "RAV4", active: true, params: { make: "Toyota", model: "RAV4" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], settings: { budget: 30000, marketcheckKeys: [{ key: "KEY-ONE-1111", label: "Personal" }, { key: "KEY-TWO-2222", label: "" }, { key: "KEY-ONE-1111", label: "dupe" }] },
};
const h = vi.hoisted(() => ({ writes: [], imported: null, fail: false }));
const chain = () => { const c = {}; ["select","eq","maybeSingle","update","insert","order","limit","single","delete","upsert"].forEach(m => c[m] = () => c); c.then = (r) => r({ data: null, error: null }); return c; };

vi.mock("../src/storage", () => ({ default: {
  get: async () => ({ key: "k", value: JSON.stringify(state), rev: 3 }),
  set: async (k, v, rev) => { h.writes.push(JSON.parse(v)); return { key: k, value: v, rev: (rev || 0) + 1 }; },
  delete: async () => ({}),
} }));
vi.mock("../src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@y.z" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  from: () => chain(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
} }));
vi.mock("../src/Auth", () => ({ default: ({ children }) => children, signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({ listings: [] }), fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), postStep: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({ isAdmin: false }), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));
vi.mock("../src/keys", async (orig) => Object.assign({}, await orig(), {
  listMarketcheckKeys: async () => [],
  importMarketcheckKeys: async (entries) => {
    if (h.fail) throw new Error("vault down");
    h.imported = entries;
    return entries.map((e, i) => ({ id: i + 1, label: e.label, last4: e.key.slice(-4), position: i, valid: true }));
  },
}));

const App = (await import("../src/App.jsx")).default;

describe("moving MarketCheck keys out of the blob", () => {
  it("imports them (deduplicated, in order) and saves settings without them", async () => {
    render(React.createElement(App));
    await waitFor(() => expect(h.imported).not.toBeNull());
    expect(h.imported).toEqual([{ key: "KEY-ONE-1111", label: "Personal" }, { key: "KEY-TWO-2222", label: "" }]);
    await waitFor(() => expect(h.writes.some((d) => d.settings && d.settings.marketcheckKeys === undefined && d.settings.budget === 30000)).toBe(true));
  });
});
