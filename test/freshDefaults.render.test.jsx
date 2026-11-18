// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// Generic defaults for a new account, the budget figure, "Needs check" only for
// hand-added cars, and a duplicate approve that says so instead of doing nothing.
const OLD = "2026-01-01";
const store = { state: null };
const writes = [];
const chain = () => { const c = {}; ["select","eq","maybeSingle","update","insert","order","limit","single","delete","upsert"].forEach(m => c[m] = () => c); c.then = (r) => r({ data: null, error: null }); return c; };
vi.mock("../src/storage", () => ({ watchState: async () => () => {}, default: {
  get: async () => (store.state ? { key: "k", value: JSON.stringify(store.state), rev: 3 } : null),
  set: async (v) => { writes.push(JSON.parse(v)); return { rev: 4 + writes.length }; },
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

describe("a new account", () => {
  it("starts blank: no profiles, three starter rules, $30,000, Boston", async () => {
    store.state = null;
    writes.length = 0;
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Set up your search", {}, { timeout: 4000 });
    expect(screen.queryByText(/Durham|two-car/)).toBeNull();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByDisplayValue("30000")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText(/add your first car on the/)).toBeTruthy();
    expect(screen.queryByText(/Keep my/)).toBeNull();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("No accident history")).toBeTruthy();
    expect(screen.queryByText(/gold|black/i)).toBeNull();
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(screen.getByText("Finish setup"));
    await waitFor(() => expect(writes.some((w) => w.onboarded)).toBe(true));
    const d = writes.find((w) => w.onboarded);
    expect(d.profiles).toEqual([]);
    expect(d.globalReqs.map((r) => r.id)).toEqual(["clean-title", "no-accidents", "no-mech"]);
    expect(d.settings).toMatchObject({ budget: 30000, homeBase: { n: "Boston, MA", z: "02108" } });
    expect(d.settings.taxRate).toBeUndefined();
    cleanup();
  });
});

describe("watchlist freshness + budget", () => {
  it("flags only hand-added cars; shows under/over budget; a duplicate approve says so", async () => {
    const car = (o) => Object.assign({ year: 2022, vehicle: "Toyota RAV4", price: 25000, mileage: 30000, profileId: "p1", status: "watch", dealer: "D", dealerType: "franchise", lastChecked: OLD }, o);
    store.state = {
      version: 10, onboarded: true,
      profiles: [{ id: "p1", name: "RAV4", active: true, params: { make: "Toyota", model: "RAV4" } }],
      criteria: [{ id: "price", name: "Price", weight: 25 }],
      listings: [car({ id: "a", vin: "SYNCED00000000001", source: "marketcheck", lastSeen: OLD }), car({ id: "b", vin: "MANUAL00000000001", price: 32000 })],
      // an older skip of the car now on the watchlist (a queued duplicate is dropped on load)
      skipped: [car({ vin: "SYNCED00000000001", price: 26000, source: "marketcheck", status: undefined, skippedAt: OLD })],
      settings: { budget: 30000 },
    };
    writes.length = 0;
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Tirekicker", {}, { timeout: 4000 });
    expect(screen.getByText(/hand-added listing not checked/)).toBeTruthy();
    expect(screen.queryByText("Mark all fresh")).toBeNull();
    expect(screen.getByText("$5,000 under budget")).toBeTruthy();
    expect(screen.getByText("$2,000 over budget")).toBeTruthy();

    fireEvent.click(screen.getByText(/^Results/));
    await screen.findByText(/Needs check \(1\)/);
    expect(screen.getByText(/^Watchlist \(1\)/)).toBeTruthy();
    expect(screen.getAllByText("Still avail").length).toBe(1);
    expect(screen.queryByText(/^Import$/)).toBeNull();

    fireEvent.click(screen.getByText(/Skipped \(1\)/));
    fireEvent.click(screen.getByText("↩ Restore to queue"));
    fireEvent.click(await screen.findByText("✓ Add to Watchlist"));
    await screen.findByText(/Already on your watchlist at the same or a lower price/);
    cleanup();
  });
});
