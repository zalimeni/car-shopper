// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { SettingsCard } = await import("../src/App.jsx");

const base = (keys) => ({ profiles: [], listings: [], settings: { budget: 40000, tagline: "t", hubs: [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }], marketcheckKeys: keys } });
// Saving loads the location index first (to fill missing coordinates), so it's async.
async function saveAndGet(data, edit) {
  const save = vi.fn();
  render(<SettingsCard data={data} save={save} />);
  fireEvent.click(screen.getByText("Edit"));
  if (edit) edit();
  fireEvent.click(screen.getByText("Save settings"));
  await waitFor(() => expect(save).toHaveBeenCalled());
  cleanup();
  return save.mock.calls[0][0].settings;
}

describe("Settings de-duplicates MarketCheck keys on save", () => {
  it("collapses a key that's already in the list twice", async () => {
    const saved = (await saveAndGet(base([{ key: "KEY-A", label: "" }, { key: "KEY-B", label: "Spare" }, { key: "KEY-A", label: "Personal" }]))).marketcheckKeys;
    expect(saved).toEqual([{ key: "KEY-A", label: "Personal" }, { key: "KEY-B", label: "Spare" }]);
  });
  it("collapses a duplicate the user just typed in", async () => {
    const saved = (await saveAndGet(base([{ key: "KEY-A", label: "Personal" }]), () => {
      fireEvent.click(screen.getByText("+ Add MarketCheck key"));
      const boxes = screen.getAllByPlaceholderText("MarketCheck API key");
      fireEvent.change(boxes[boxes.length - 1], { target: { value: "  KEY-A " } });
    })).marketcheckKeys;
    expect(saved).toEqual([{ key: "KEY-A", label: "Personal" }]);
  });
  it("leaves a clean list alone, in order", async () => {
    expect((await saveAndGet(base([{ key: "KEY-B", label: "" }, { key: "KEY-A", label: "" }]))).marketcheckKeys.map((k) => k.key)).toEqual(["KEY-B", "KEY-A"]);
  });
});

describe("Settings save fills missing location coordinates", () => {
  it("looks a bare-ZIP location up in the location list", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => "MA|Boston|02108|42.3576|-71.0684\nNC|Durham|27701|35.9968|-78.8996\n" }));
    const d = base([]);
    d.settings.hubs = [{ n: "Boston, MA", z: "02108" }, { n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }];
    const hubs = (await saveAndGet(d)).hubs;
    expect(hubs.find((h) => h.z === "02108")).toMatchObject({ lat: 42.3576, lon: -71.0684 });
    expect(hubs.find((h) => h.z === "27701")).toMatchObject({ lat: 36, lon: -78.9 });
  });
});
