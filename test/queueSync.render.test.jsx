// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

// A returning user whose saved queue holds a car they've since skipped: the app
// restores the queue without it and writes the pruned queue back.
const state = {
  version: 8, onboarded: true,
  profiles: [{ id: "p1", name: "Tucson", active: true, params: { make: "Hyundai", model: "Tucson" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], skipped: [{ vin: "SKIPPED00000000001" }], settings: {},
  candidates: [{ vin: "QUEUED000000000001", year: 2023, vehicle: "Hyundai Tucson", price: 25000, profileId: "p1", _candidate: true },
               { vin: "SKIPPED00000000001", year: 2023, vehicle: "Hyundai Tucson", price: 24000, profileId: "p1", _candidate: true }],
};
const writes = [];
const chain = () => { const c = {}; ["select","eq","maybeSingle","update","insert","order","limit","single","delete","upsert"].forEach(m => c[m] = () => c); c.then = (r) => r({ data: null, error: null }); return c; };
vi.mock("../src/storage", () => ({ default: {
  get: async () => ({ key: "k", value: JSON.stringify(state), rev: 3 }),
  set: async (k, v) => { writes.push(JSON.parse(v)); return { rev: 4 + writes.length }; },
  delete: async () => ({}),
} }));
vi.mock("../src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@y.z" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  from: () => chain(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
} }));
vi.mock("../src/Auth", () => ({ default: ({ children }) => children, signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({ listings: [] }), postStep: async () => ({}), fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({ isAdmin: false }), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const App = (await import("../src/App.jsx")).default;

describe("the review queue syncs through the app state", () => {
  it("restores the saved queue, prunes decided cars, and writes it back once", async () => {
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0].candidates.map((c) => c.vin)).toEqual(["QUEUED000000000001"]);
    await new Promise((r) => setTimeout(r, 1200)); // past the queue's save delay
    expect(writes.length).toBe(1); // restoring doesn't trigger a second write
  });
});
