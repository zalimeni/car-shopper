// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// Results' profile filter defaults to the active profiles but offers any, and the
// candidate queue, its hidden (trim/color) list and the skipped list follow it.
const car = (vin, profileId, extra) => Object.assign({ vin, year: 2022, vehicle: profileId === "p1" ? "Hyundai Tucson" : "Subaru Outback", price: 25000, mileage: 30000, profileId, _candidate: true }, extra || {});
const state = {
  version: 9, onboarded: true,
  profiles: [{ id: "p1", name: "Tucson", active: true, params: { make: "Hyundai", model: "Tucson", excludeTrims: ["Blue HEV AWD"] } },
             { id: "p2", name: "Outback", active: false, params: { make: "Subaru", model: "Outback", excludeTrims: ["Limited XT"] } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [],
  candidates: [car("T0000000000000001", "p1"), car("T0000000000000002", "p1"), car("T0000000000000003", "p1", { trim: "Blue HEV AWD" }),
               car("S0000000000000001", "p2"), car("S0000000000000002", "p2", { trim: "Limited XT" })],
  skipped: [Object.assign(car("T0000000000000009", "p1"), { _candidate: undefined }), Object.assign(car("S0000000000000009", "p2"), { _candidate: undefined })],
  settings: {},
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

describe("Results profile filter", () => {
  it("defaults to active profiles; candidates, hidden and skipped follow it", async () => {
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    fireEvent.click(screen.getByText(/^Results/));
    await screen.findByText("Candidates (2)");
    expect(screen.getByText(/Hidden by your trim, drivetrain or color filters \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Skipped \(1\)/)).toBeTruthy();

    // the select offers Active (default), All, and every profile — inactive ones marked
    const sel = screen.getByDisplayValue("Active profiles");
    expect(within(sel).getByText("Outback (inactive)")).toBeTruthy();
    fireEvent.change(sel, { target: { value: "all" } });
    await screen.findByText("Candidates (3)");
    expect(screen.getByText(/Hidden by your trim, drivetrain or color filters \(2\)/)).toBeTruthy();
    expect(screen.getByText(/Skipped \(2\)/)).toBeTruthy();
    fireEvent.change(sel, { target: { value: "p2" } });
    await screen.findByText(/Skipped \(1\)/);
    expect(screen.getByText("Candidates (1)")).toBeTruthy(); // an inactive profile is still selectable
    fireEvent.change(sel, { target: { value: "active" } });
    await screen.findByText("Candidates (2)");

    // Approve All approves what's shown: the two active Tucsons, not the Outback
    fireEvent.click(screen.getByText("Approve All"));
    await waitFor(() => expect(writes.some((w) => w.listings.length === 2)).toBe(true));
    expect(writes.find((w) => w.listings.length === 2).listings.map((l) => l.vin).sort()).toEqual(["T0000000000000001", "T0000000000000002"]);
  });
});
