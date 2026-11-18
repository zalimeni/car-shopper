// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";

// Signed in, App takes AuthGate's one /api/me answer (`me`) for the admin
// flag and key metadata instead of asking /api/me and /api/keys again.
const calls = vi.hoisted(() => ({ keyStatus: 0, me: 0, mcKeys: 0 }));
const state = {
  version: 10, onboarded: true,
  profiles: [{ id: "p1", name: "RAV4", active: true, params: { make: "Toyota", model: "RAV4" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], settings: {},
};
const chain = () => { const c = {}; ["select","eq","maybeSingle","update","insert","order","limit","single","delete","upsert"].forEach(m => c[m] = () => c); c.then = (r) => r({ data: null, error: null }); return c; };

vi.mock("../src/storage", () => ({ watchState: async () => () => {}, default: {
  get: async () => ({ key: "k", value: JSON.stringify(state), rev: 3 }),
  set: async () => ({ ok: true, rev: 4 }),
  delete: async () => ({}),
} }));
vi.mock("../src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@y.z" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  from: () => chain(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
} }));
vi.mock("../src/Auth", () => ({ default: ({ children }) => children, signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({ listings: [] }), fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => { calls.keyStatus++; return {}; }, saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("../src/admin", () => ({ getMe: async () => { calls.me++; return {}; }, listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/keys", async (orig) => Object.assign({}, await orig(), { listMarketcheckKeys: async () => { calls.mcKeys++; return []; } }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const App = (await import("../src/App.jsx")).default;

describe("App uses AuthGate's /api/me answer", () => {
  it("shows the Admin tab from `me` without calling /api/me or /api/keys again", async () => {
    var me = { authorized: true, isAdmin: true, anthropicKey: { configured: true, valid: true, last4: "abcd" }, marketcheckKeys: [{ id: 1, label: "main", last4: "wxyz", position: 0, valid: true }] };
    render(React.createElement(App, { me: me }));
    await screen.findByText("Admin", {}, { timeout: 4000 });
    expect(calls).toEqual({ keyStatus: 0, me: 0, mcKeys: 0 });
  });
});
