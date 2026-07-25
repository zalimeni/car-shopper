// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Avoid importing the whole App/network stack — mock the side-effecty modules
// App.jsx pulls in, so importing PriceCheckTab is cheap and offline.
vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { PriceCheckTab } = await import("../src/App.jsx");

const data = {
  profiles: [{ id: "p1", name: "RAV4", active: true, params: { make: "Toyota", model: "RAV4", years: "2021" } }],
  listings: [
    { vin: "A", year: 2021, vehicle: "Toyota RAV4", trim: "XLE", mileage: 40000, price: 24000, status: "watch", profileId: "p1", priceHistory: [{ date: "2026-06-01", price: 25000 }, { date: "2026-06-20", price: 24000 }] },
    { vin: "B", year: 2021, vehicle: "Toyota RAV4", trim: "LE", mileage: 45000, price: 22500, status: "rejected", rejectReason: "miles", profileId: "p1" },
    { vin: "C", year: 2020, vehicle: "Toyota RAV4", trim: "XLE", mileage: 52000, price: 21000, status: "sold", profileId: "p1" },
  ],
  skipped: [], pendingCandidates: [],
};

describe("PriceCheckTab renders + runs without crashing", () => {
  it("initial render shows the form", () => {
    render(<PriceCheckTab data={data} candidates={[]} />);
    expect(screen.getByText("Price check")).toBeTruthy();
    cleanup();
  });
  it("running a check renders the verdict + comps (no throw)", () => {
    const { container } = render(<PriceCheckTab data={data} candidates={[]} />);
    // fill make/model/year/asking, then click Check
    const inputs = container.querySelectorAll("input");
    // order: vin, year, make, model, trim, mileage, asking
    fireEvent.change(inputs[1], { target: { value: "2021" } });
    fireEvent.change(inputs[2], { target: { value: "Toyota" } });
    fireEvent.change(inputs[3], { target: { value: "RAV4" } });
    fireEvent.change(inputs[6], { target: { value: "27000" } });
    fireEvent.click(screen.getByText("Check price"));
    // A verdict + comp table should appear.
    expect(container.textContent).toMatch(/\d+ comps?/);
    expect(container.textContent).toMatch(/median/);
    cleanup();
  });
  it("prefill-from-profile then check works", () => {
    const { container } = render(<PriceCheckTab data={data} candidates={[]} />);
    fireEvent.click(screen.getByText("RAV4")); // profile prefill chip
    fireEvent.click(screen.getByText("Check price"));
    expect(container.textContent).toMatch(/\d+ comps?/);
    cleanup();
  });
});
