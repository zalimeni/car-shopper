// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, act } from "@testing-library/react";

// Realtime: a save from another device (higher rev) reloads this session; an
// event for a rev this tab already has (its own save) does nothing.
const state = (tagline) => ({
  version: 10, onboarded: true,
  profiles: [{ id: "p1", name: "RAV4", active: true, params: { make: "Toyota", model: "RAV4" } }],
  criteria: [{ id: "price", name: "Price", weight: 25 }],
  listings: [], candidates: [], settings: { tagline: tagline },
});
var stored = { rev: 3, data: state("first tagline") };
var onChange = null;
var gets = 0;

vi.mock("../src/storage", () => ({
  watchState: async (cb) => { onChange = cb; return () => { onChange = null; }; },
  default: {
    get: async () => { gets++; return { key: "k", value: JSON.stringify(stored.data), rev: stored.rev }; },
    set: async (k, v) => ({ key: k, value: v, rev: stored.rev }),
  },
}));
vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } } }));
vi.mock("../src/Auth", () => ({ default: ({ children }) => children, signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({ listings: [] }), fetchPriceComps: async () => ({ listings: [] }), fetchRawSample: async () => ({}), reconcile: () => ({ listings: [], candidates: [], summary: {} }) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({ system: "", guidance: {} }), generateBaseline: async () => ({}), SCORE_MODEL_OPTIONS: [{ id: "m", label: "m" }], DEFAULT_SCORE_MODEL: "m" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({ isAdmin: false }), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const App = (await import("../src/App.jsx")).default;

describe("Realtime reload", () => {
  it("ignores its own rev, reloads on a newer one", async () => {
    render(React.createElement(App));
    await screen.findByText("first tagline", {}, { timeout: 4000 });
    await vi.waitFor(() => expect(onChange).toBeTypeOf("function"));
    const before = gets;

    await act(async () => { onChange(3); await new Promise((r) => setTimeout(r, 20)); });
    expect(gets).toBe(before); // same rev: no refetch
    expect(screen.queryByText(/updated on another device/)).toBeNull();

    stored = { rev: 4, data: state("second tagline") };
    await act(async () => { onChange(4); await new Promise((r) => setTimeout(r, 20)); });
    await screen.findByText("second tagline");
    expect(screen.getByText(/updated on another device, so this session loaded the latest version/)).toBeTruthy();
  });
});
