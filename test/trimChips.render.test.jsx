// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// Profile editor trim chips: saved states render, a tap cycles ☆ → ★ → hidden,
// drivetrain chips show when there's more than one, and Save writes the arrays.
const state = {
  version: 8, onboarded: true,
  profiles: [{ id: "ob", name: "Outback", active: true, params: { make: "Subaru", model: "Outback", years: "2020-2022", maxPrice: 25000, maxMiles: 100000,
    trims: "Premium", preferTrims: ["Premium"], excludeTrims: ["Touring XT"] } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [{ id: "l1", vin: "4S4BTANC0L3000001", year: 2020, vehicle: "Subaru Outback", trim: "Base", drivetrain: "4WD", price: 20000, mileage: 50000, profileId: "ob", status: "watch" }],
  skipped: [], candidates: [],
  settings: { mcProfiles: { ob: { trims: { counts: { "Limited": 1125, "Premium": 1109, "Touring XT": 356 }, unlisted: 0, at: "2026-10-16T05:00:00Z" },
    drivetrains: { counts: { "4WD": 3900, "FWD": 16 }, unlisted: 0, at: "2026-10-16T05:00:00Z" } } } },
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

describe("profile trim chips", () => {
  it("show saved states, cycle on tap, and save as arrays", async () => {
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    fireEvent.click(screen.getAllByText("Profiles")[0]);
    fireEvent.click(await screen.findByText("Edit"));

    // facet trims by count, then "Base" seen on a synced car
    expect(screen.getByLabelText("Touring XT (hidden)")).toBeTruthy();
    expect(screen.getByLabelText("Premium (preferred)")).toBeTruthy();
    expect(screen.getByLabelText("Base")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Limited"));            // → preferred
    fireEvent.click(screen.getByLabelText("Base"));               // → preferred
    fireEvent.click(screen.getByLabelText("Base (preferred)"));   // → hidden
    fireEvent.click(screen.getByText(/^FWD/));                    // drivetrain chip → hidden
    fireEvent.click(screen.getByText("Save profile"));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const p = writes.at(-1).profiles[0].params;
    expect(p.excludeTrims).toEqual(["Touring XT", "Base"]);
    expect(p.preferTrims).toEqual(["Premium", "Limited"]);
    expect(p.trims).toBe("Premium, Limited");
    expect(p.excludeDrivetrains).toEqual(["FWD"]);
  });
});
