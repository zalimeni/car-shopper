// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";

// Returning user with OLD-version data -> migrate bumps version -> a write-back
// is triggered. We make the write HANG forever; the app must still render (the
// bug was setLoading(false) sitting behind that write).
const oldState = {
  version: 1, onboarded: true,
  profiles: [{ id: "p1", name: "RAV4", active: true, params: { make: "Toyota", model: "RAV4" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], settings: {},
};
const chain = () => { const c = {}; ["select","eq","maybeSingle","update","insert","order","limit","single","delete","upsert"].forEach(m => c[m] = () => c); c.then = (r) => r({ data: null, error: null }); return c; };

vi.mock("/home/user/car-shopper/src/storage", () => ({ default: {
  get: async () => ({ key: "k", value: JSON.stringify(oldState), rev: 3 }),
  set: () => new Promise(() => {}), // HANGS forever
  delete: async () => ({}),
} }));
vi.mock("/home/user/car-shopper/src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@y.z" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  from: () => chain(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
} }));
vi.mock("/home/user/car-shopper/src/Auth", () => ({ default: ({ children }) => children, signOut: () => {} }));
vi.mock("/home/user/car-shopper/src/sync", () => ({ fetchListings: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("/home/user/car-shopper/src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("/home/user/car-shopper/src/admin", () => ({ getMe: async () => ({ isAdmin: false }), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("/home/user/car-shopper/src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const App = (await import("/home/user/car-shopper/src/App.jsx")).default;

describe("App load does not hang on a stalled write-back", () => {
  it("renders the app even when the initial persist never resolves", async () => {
    render(React.createElement(App));
    // Header appears -> got past "Loading..." despite the hung write.
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    expect(screen.queryByText("Loading...")).toBeNull();
  });
});
