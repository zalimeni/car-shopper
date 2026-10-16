// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// Compare columns: 📌 pins one (saved to settings.compareCols), dragging a
// header's grip onto another moves it, and a saved layout renders in its order.
const state = {
  version: 8, onboarded: true,
  profiles: [{ id: "p1", name: "Tucson", active: true, params: { make: "Hyundai", model: "Tucson" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [{ id: "l1", vin: "KM8JCCD10RU198791", year: 2023, vehicle: "Hyundai Tucson", trim: "SEL", price: 25000, mileage: 30000,
    profileId: "p1", status: "watch", link: "https://dealer.example/car/1", tags: ["Called dealer"], lastChecked: "2026-10-15" }],
  skipped: [], settings: { compareCols: { order: ["spec:mileage", "score"], pinned: ["spec:price"] } }, candidates: [],
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

const headers = () => Array.from(document.querySelectorAll("th[data-colkey]")).map((th) => th.getAttribute("data-colkey"));

describe("Compare column layout", () => {
  it("renders the saved order + pins, pins via 📌, reorders by drag", async () => {
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    fireEvent.click(screen.getAllByText("Compare")[0]);
    await screen.findByTitle("Open this listing");
    // pinned first, then the saved order; columns it doesn't list follow their default neighbour
    expect(headers().slice(0, 3)).toEqual(["spec:price", "spec:mileage", "spec:year"]);
    expect(headers().indexOf("score")).toBeGreaterThan(headers().indexOf("spec:mileage"));
    const priceTh = document.querySelector('th[data-colkey="spec:price"]');
    expect(priceTh.style.position).toBe("sticky");

    // pin Year
    const yearTh = document.querySelector('th[data-colkey="spec:year"]');
    fireEvent.click(within(yearTh).getByTitle("Pin this column to the left"));
    await waitFor(() => expect((writes.at(-1).settings.compareCols || {}).pinned).toEqual(["spec:price", "spec:year"]));
    expect(headers().slice(0, 2)).toEqual(["spec:price", "spec:year"]);

    // drag Color's grip onto Mileage
    const colorTh = document.querySelector('th[data-colkey="spec:color"]');
    const mileTh = document.querySelector('th[data-colkey="spec:mileage"]');
    document.elementFromPoint = () => mileTh;
    fireEvent.pointerDown(within(colorTh).getByLabelText(/Drag to move/), { button: 0, pointerType: "touch", clientX: 500, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 10 });
    await waitFor(() => expect(headers().slice(0, 4)).toEqual(["spec:price", "spec:year", "spec:color", "spec:mileage"]));
    expect(writes.at(-1).settings.compareCols.pinned).toEqual(["spec:price", "spec:year"]);
  });
});
