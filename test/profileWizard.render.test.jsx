// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// The new-profile wizard: Explore (one count call: facets + stats) → quick-pick
// caps, leave a year out, hide a trim → AI suggestions fill the scoring fields →
// Create saves the profile with its facets, then checks the exact count.
const state = {
  version: 9, onboarded: true, profiles: [], criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], skipped: [], candidates: [], settings: { homeBase: { n: "Durham NC", z: "27701", lat: 35.99, lon: -78.9 } },
};
const steps = [];
const explore = { numFound: 1001, errors: [], keyQuotas: [],
  trims: { counts: { "Limited HEV AWD": 357, "SEL Convenience HEV AWD": 339, "Blue HEV AWD": 203 }, unlisted: 0 },
  drivetrains: { counts: { "4WD": 1001 }, unlisted: 0 },
  colors: { counts: { Black: 261, Gray: 204 }, unlisted: 34 },
  years: { counts: { 2022: 300, 2023: 400, 2024: 301 }, unlisted: 0 },
  stats: { price: { min: 11799, max: 41497, median: 28178, percentiles: { "5.0": 20200, "25.0": 25514, "50.0": 28178, "75.0": 30339, "90.0": 32590, "99.0": 36554 } },
           miles: { min: 12, max: 175137, median: 35832, percentiles: { "5.0": 10887, "25.0": 24603, "50.0": 35832, "75.0": 53986, "90.0": 76832, "99.0": 118956 } } } };
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
vi.mock("../src/sync", () => ({ fetchListings: async () => ({ listings: [] }), postStep: async (step) => { steps.push(step); return steps.length === 1 ? explore : Object.assign({}, explore, { numFound: 240 }); }, fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({ valid: true }), suggestProfile: async () => ({ mustHave: "heated seats", niceToHave: "", dealbreakers: "flood damage", summary: "Look for a Limited.", avoidYears: [{ year: 2022, reason: "first-year bugs" }], trimNotes: [{ trim: "Blue HEV AWD", note: "base trim" }] }), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({ isAdmin: false }), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const App = (await import("../src/App.jsx")).default;

describe("new-profile wizard", () => {
  it("explores once, picks caps/years/trims, takes AI suggestions, creates the profile", async () => {
    localStorage.clear();
    render(React.createElement(App));
    await screen.findByText("Car Shopper", {}, { timeout: 4000 });
    fireEvent.click(screen.getAllByText("Profiles")[0]);
    fireEvent.click(within(screen.getByText("Vehicle Profiles").parentElement).getByText("+ Add"));
    const dlg = screen.getByRole("dialog", { name: "New profile" });
    fireEvent.change(within(dlg).getByPlaceholderText("Subaru"), { target: { value: "Hyundai" } });
    fireEvent.change(within(dlg).getByPlaceholderText("Outback"), { target: { value: "Tucson" } });
    fireEvent.change(within(dlg).getByLabelText("Powertrain"), { target: { value: "Hybrid" } });
    fireEvent.change(within(dlg).getByLabelText("From year"), { target: { value: "2022" } });
    fireEvent.click(within(dlg).getByText("Explore (1 call)"));

    await within(dlg).findByText(/1,001 Hyundai Tucson for sale nationwide/);
    expect(steps[0]).toMatchObject({ kind: "count", profile: { params: { make: "Hyundai", model: "Tucson", powertrain: "Hybrid" } } });
    expect(steps[0].profile.params.maxPrice).toBeUndefined(); // explore has no caps
    expect(steps[0].profile.params.years).toMatch(/^2022-20\d\d$/); // From 2022, To open → through next model year
    // the To select now shows each year's count
    expect(within(within(dlg).getByLabelText("To year")).getByText("2024 · 301")).toBeTruthy();
    // caps default to the median price and 75th-percentile miles
    expect(within(dlg).getByDisplayValue("28500")).toBeTruthy();
    expect(within(dlg).getByDisplayValue("55000")).toBeTruthy();
    fireEvent.click(within(dlg).getByText("$30,500 · 75%"));

    fireEvent.click(within(dlg).getByLabelText("Blue HEV AWD"));                // ★
    fireEvent.click(within(dlg).getByLabelText("Blue HEV AWD (preferred)"));    // hidden

    fireEvent.click(within(dlg).getByText("✨ Suggest must-haves and years to avoid"));
    await within(dlg).findByText("first-year bugs");
    expect(within(dlg).getByDisplayValue("heated seats")).toBeTruthy();
    fireEvent.click(within(dlg).getByText("Leave out 2022"));
    expect(within(dlg).getByText(/2022 left out/)).toBeTruthy();

    fireEvent.click(within(dlg).getByText("Create profile"));
    await waitFor(() => expect(writes.some((w) => w.profiles.length === 1)).toBe(true));
    const saved = writes.find((w) => w.profiles.length === 1);
    const prof = saved.profiles[0];
    expect(prof).toMatchObject({ name: "Hyundai Tucson Hybrid", active: true });
    expect(prof.params).toMatchObject({ make: "Hyundai", model: "Tucson", powertrain: "Hybrid", years: "2023-2024", maxPrice: 30500, maxMiles: 55000,
      excludeTrims: ["Blue HEV AWD"], mustHave: "heated seats", dealbreakers: "flood damage" });
    expect(saved.settings.mcProfiles[prof.id].trims.counts["Limited HEV AWD"]).toBe(357);
    // then the exact count at the chosen caps (one more call)
    await waitFor(() => expect(steps.length).toBe(2));
    expect(steps[1].profile.params.maxPrice).toBe(30500);
    await waitFor(() => expect(writes.at(-1).settings.mcProfiles[prof.id].count).toBe(240));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
