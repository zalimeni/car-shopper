// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {}, setAllowedFlags: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));
const keysApi = vi.hoisted(() => ({
  add: vi.fn(async (key, label) => [{ id: 1, label: label, last4: key.slice(-4), position: 0, valid: true }]),
  reorder: vi.fn(async (ids) => ids.map((id, i) => ({ id: id, label: "", last4: "000" + id, position: i, valid: true }))),
  remove: vi.fn(async () => []),
}));
vi.mock("../src/keys", async (orig) => Object.assign({}, await orig(), {
  addMarketcheckKey: keysApi.add, reorderMarketcheckKeys: keysApi.reorder, removeMarketcheckKey: keysApi.remove,
  listMarketcheckKeys: async () => [], importMarketcheckKeys: async () => [], renameMarketcheckKey: async () => [],
}));

const { SettingsCard, McKeysCard } = await import("../src/App.jsx");
const { legacyBlobKeys } = await import("../src/keys.js");

const base = () => ({ profiles: [], listings: [], settings: { budget: 40000, tagline: "t", homeBase: { n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 } } });
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

describe("MarketCheck keys live in the vault", () => {
  it("adds a key through /api/keys and shows only its label and last 4", async () => {
    const setKeys = vi.fn();
    render(<McKeysCard keys={[]} setKeys={setKeys} />);
    fireEvent.change(screen.getByPlaceholderText("label (optional)"), { target: { value: "Personal" } });
    fireEvent.change(screen.getByPlaceholderText("MarketCheck API key"), { target: { value: "  abcdEFGH12345678wxyz " } });
    fireEvent.click(screen.getByText("Add key"));
    await waitFor(() => expect(setKeys).toHaveBeenCalled());
    expect(keysApi.add).toHaveBeenCalledWith("abcdEFGH12345678wxyz", "Personal");
    cleanup();
    render(<McKeysCard keys={setKeys.mock.calls[0][0]} setKeys={setKeys} />);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("••••wxyz")).toBeTruthy();
    expect(document.body.textContent).not.toContain("abcdEFGH");
    cleanup();
  });
  it("moves a key down by sending the new order", async () => {
    const setKeys = vi.fn();
    render(<McKeysCard keys={[{ id: 7, label: "A", last4: "0007" }, { id: 9, label: "B", last4: "0009" }]} setKeys={setKeys} />);
    fireEvent.click(screen.getAllByLabelText("Move down")[0]);
    await waitFor(() => expect(keysApi.reorder).toHaveBeenCalledWith([9, 7]));
    cleanup();
  });
  it("the settings card no longer saves keys into the blob", async () => {
    const saved = await saveAndGet(base());
    expect(saved.marketcheckKeys).toBeUndefined();
  });
  it("legacyBlobKeys reads an old blob's keys in order, skipping blanks", () => {
    expect(legacyBlobKeys({ marketcheckKeys: [{ key: "K1", label: "one" }, "K2", { key: " " }, null] })).toEqual([{ key: "K1", label: "one" }, { key: "K2", label: "" }]);
    expect(legacyBlobKeys({})).toEqual([]);
    expect(legacyBlobKeys(undefined)).toEqual([]);
  });
});

describe("Settings save: home base and salt belt", () => {
  it("a home base saved as a bare ZIP gets its coordinates from the location list", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => "MA|Boston|02108|42.3576|-71.0684\nNC|Durham|27701|35.9968|-78.8996\n" }));
    const d = base();
    d.settings.homeBase = { n: "02108", z: "02108" };
    expect((await saveAndGet(d)).homeBase).toMatchObject({ z: "02108", lat: 42.3576, lon: -71.0684 });
  });
  it("keeps a located home base and saves the salt-belt choice", async () => {
    const saved = await saveAndGet(base(), () => {
      fireEvent.change(screen.getByDisplayValue("Exclude from searches"), { target: { value: "flag" } });
    });
    expect(saved.homeBase).toMatchObject({ z: "27701", lat: 36, lon: -78.9 });
    expect(saved.saltMode).toBe("flag");
  });
});
