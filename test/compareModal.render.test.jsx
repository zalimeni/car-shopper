// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// Compare shows each row's tags, and tapping a row opens the same card Results
// shows — where tags can be edited and the listing link still works.
const state = {
  version: 8, onboarded: true,
  profiles: [{ id: "p1", name: "Tucson", active: true, params: { make: "Hyundai", model: "Tucson" } },
             { id: "p2", name: "Outback", active: false, params: { make: "Subaru", model: "Outback" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [{ id: "l1", vin: "KM8JCCD10RU198791", year: 2023, vehicle: "Hyundai Tucson", trim: "SEL", price: 25000, mileage: 30000,
    profileId: "p1", status: "watch", link: "https://dealer.example/car/1", tags: ["Called dealer"], lastChecked: "2026-10-15" },
    { id: "l2", vin: "4S4BTANC0L3000002", year: 2021, vehicle: "Subaru Outback", price: 22000, mileage: 40000, profileId: "p2", status: "watch" }],
  skipped: [], settings: {}, candidates: [],
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

describe("Compare rows", () => {
  it("show tags, and open the listing card in a modal for tag edits", async () => {
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    fireEvent.click(screen.getAllByText("Compare")[0]);
    const row = (await screen.findByTitle("Open this listing"));
    expect(within(row).getByText(/Called dealer/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(row);
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByTitle("Remove tag Called dealer")).toBeTruthy();
    expect(within(dlg).getAllByRole("link").some((a) => a.getAttribute("href") === "https://dealer.example/car/1")).toBe(true);

    fireEvent.click(within(dlg).getByText("+ tag"));
    const box = within(dlg).getByLabelText("Tag");
    fireEvent.change(box, { target: { value: "Test drive" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(writes.some((w) => (w.listings[0].tags || []).join("|") === "Called dealer|Test drive")).toBe(true));
    // the row updates behind the modal
    expect(within(row).getByText(/Test drive/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // only active profiles start selected; tapping the inactive one adds its cars
    expect(screen.getAllByTitle("Open this listing").length).toBe(1);
    fireEvent.click(screen.getByText("Outback"));
    expect(screen.getAllByTitle("Open this listing").length).toBe(2);
  });
});
