// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// The tutorial, signed in: launched from Help, walks the tabs, and a step whose
// action would spend MarketCheck calls (↻ Sync) only explains — Next moves on
// without syncing.
const state = {
  version: 8, onboarded: true,
  profiles: [{ id: "p1", name: "Tucson", active: true, params: { make: "Hyundai", model: "Tucson", maxPrice: 30000, maxMiles: 60000 } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], skipped: [{ vin: "SKIPPED00000000001" }], settings: {},
  candidates: [{ vin: "QUEUED000000000001", year: 2023, vehicle: "Hyundai Tucson", price: 25000, profileId: "p1", _candidate: true },
               { vin: "SKIPPED00000000001", year: 2023, vehicle: "Hyundai Tucson", price: 24000, profileId: "p1", _candidate: true }],
};
const writes = [];
let synced = 0;
const chain = () => { const c = {}; ["select","eq","maybeSingle","update","insert","order","limit","single","delete","upsert"].forEach(m => c[m] = () => c); c.then = (r) => r({ data: null, error: null }); return c; };
vi.mock("../src/storage", () => ({ watchState: async () => () => {}, default: {
  get: async () => ({ key: "k", value: JSON.stringify(state), rev: 3 }),
  set: async (k, v) => { writes.push(JSON.parse(v)); return { rev: 4 + writes.length }; },
  delete: async () => ({}),
} }));
vi.mock("../src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@y.z" } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  from: () => chain(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
} }));
vi.mock("../src/Auth", () => ({ default: ({ children }) => children, signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => { synced++; return { listings: [] }; }, postStep: async () => ({}), fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({ isAdmin: false }), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

window.history.replaceState(null, "", "/#help");
const App = (await import("../src/App.jsx")).default;
const { STEPS } = await import("../src/tutorial.js");

describe("tutorial (signed in)", () => {
  it("starts from Help and explains costly steps without running them", async () => {
    render(React.createElement(App));
    fireEvent.click(await screen.findByRole("button", { name: "▶ Start the tutorial" }, { timeout: 8000 }));
    await screen.findByRole("dialog", { name: "Tutorial: Quick tutorial" });
    const next = () => fireEvent.click(screen.getByRole("button", { name: /^(Next|Done)$/ }));
    next();
    await screen.findByRole("dialog", { name: "Tutorial: Profiles: the cars you're hunting" }, { timeout: 8000 });
    expect(window.location.hash).toBe("#profiles");
    // Jump ahead to the sync step.
    for (const t of ["Add a car with the wizard", "What a good deal means to you", "New matches wait for review", "Sync pulls fresh inventory"]) {
      next();
      await screen.findByRole("dialog", { name: "Tutorial: " + t }, { timeout: 8000 });
    }
    expect(screen.getByText(/won't run it for you/)).toBeTruthy();
    next();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tutorial: Sync pulls fresh inventory" })).toBeNull(), { timeout: 8000 });
    expect(synced).toBe(0);
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Tutorial/ })).toBeNull());
    expect(STEPS.length).toBeGreaterThan(10);
  }, 20000);
});
