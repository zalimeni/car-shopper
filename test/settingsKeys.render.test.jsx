// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { SettingsCard } = await import("../src/App.jsx");

const base = (keys) => ({ profiles: [], listings: [], settings: { budget: 40000, tagline: "t", hubs: [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }], marketcheckKeys: keys } });
function saveAndGet(data, edit) {
  const save = vi.fn();
  render(<SettingsCard data={data} save={save} />);
  fireEvent.click(screen.getByText("Edit"));
  if (edit) edit();
  fireEvent.click(screen.getByText("Save settings"));
  cleanup();
  return save.mock.calls[0][0].settings.marketcheckKeys;
}

describe("Settings de-duplicates MarketCheck keys on save", () => {
  it("collapses a key that's already in the list twice", () => {
    const saved = saveAndGet(base([{ key: "KEY-A", label: "" }, { key: "KEY-B", label: "Spare" }, { key: "KEY-A", label: "Personal" }]));
    expect(saved).toEqual([{ key: "KEY-A", label: "Personal" }, { key: "KEY-B", label: "Spare" }]);
  });
  it("collapses a duplicate the user just typed in", () => {
    const saved = saveAndGet(base([{ key: "KEY-A", label: "Personal" }]), () => {
      fireEvent.click(screen.getByText("+ Add MarketCheck key"));
      const boxes = screen.getAllByPlaceholderText("MarketCheck API key");
      fireEvent.change(boxes[boxes.length - 1], { target: { value: "  KEY-A " } });
    });
    expect(saved).toEqual([{ key: "KEY-A", label: "Personal" }]);
  });
  it("leaves a clean list alone, in order", () => {
    expect(saveAndGet(base([{ key: "KEY-B", label: "" }, { key: "KEY-A", label: "" }])).map((k) => k.key)).toEqual(["KEY-B", "KEY-A"]);
  });
});
