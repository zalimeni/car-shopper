// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { syncWarning, liveSearchHub, LocationPicker } = await import("../src/App.jsx");

const NOW = Date.parse("2026-10-14T12:00:00Z");
const base = (over) => Object.assign({
  lastSynced: "2026-10-14T10:00:00Z",
  profiles: [{ id: "a", active: true, params: { make: "Toyota", model: "RAV4" } }, { id: "b", active: true, params: { make: "Honda", model: "CR-V" } }],
  listings: [{ mcSeen: "2026-10-11" }, { mcSeen: "2026-10-12" }],
  settings: { hubs: [{ n: "Durham, NC", z: "27701" }, { n: "Boston, MA", z: "02108" }], marketcheckKeys: [{ key: "sk-aaaa1111" }],
    mcQuota: { snaps: { "1111": { remaining: 300, limit: 500, reset: "2026-11-01T00:00:00Z", at: "x" } }, lastSync: { calls: 9, at: "x" } } },
}, over || {});

describe("syncWarning (confirm before a redundant sync)", () => {
  it("warns within 6 hours, with cost, calls left and MarketCheck's freshness", () => {
    const w = syncWarning(base(), NOW);
    expect(w).toMatch(/last sync was 2 hours ago/);
    expect(w).toMatch(/newest data on your listings is from 2026-10-12/);
    expect(w).toMatch(/about 9 MarketCheck calls \(300 left this month\)/);
    expect(w).toMatch(/Sync anyway\?/);
  });
  it("says nothing after 6 hours, or before the first sync", () => {
    expect(syncWarning(base({ lastSynced: "2026-10-14T05:00:00Z" }), NOW)).toBeNull();
    expect(syncWarning(base({ lastSynced: null }), NOW)).toBeNull();
  });
  it("estimates from the merged plan before any sync has been measured", () => {
    const d = base(); d.settings = Object.assign({}, d.settings, { mcQuota: null });
    expect(syncWarning(d, NOW)).toMatch(/It will use 2–16 MarketCheck calls\./); // 1 merged search x 2 locations, up to 8 pages each
  });
  it("counts minutes when it was very recent", () => {
    expect(syncWarning(base({ lastSynced: "2026-10-14T11:50:00Z" }), NOW)).toMatch(/10 min ago/);
  });
});

describe("liveSearchHub (Price Check searches one location)", () => {
  const hubs = [{ n: "Boston, MA", z: "02108", lat: 42.36, lon: -71.06 }, { n: "Durham, NC", z: "27701", lat: 35.99, lon: -78.9 }];
  it("uses the home base", () => {
    expect(liveSearchHub({ hubs, homeBase: { n: "Durham, NC", z: "27701", lat: 35.99, lon: -78.9 } }).z).toBe("27701");
  });
  it("borrows coordinates from the matching location when the saved home base has none", () => {
    expect(liveSearchHub({ hubs, homeBase: { n: "Durham, NC", z: "27701" } })).toMatchObject({ z: "27701", lat: 35.99 });
  });
  it("falls back to the first location, or null with none", () => {
    expect(liveSearchHub({ hubs, homeBase: null }).z).toBe("02108");
    expect(liveSearchHub({ hubs: [] })).toBeNull();
  });
});

describe("LocationPicker flags overlapping search areas", () => {
  it("warns about Durham + Raleigh, not about far-apart locations", () => {
    const FILE = readFileSync(process.cwd() + "/public/locations.txt", "utf8");
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => FILE }));
    const hubs = [{ n: "Durham, NC", z: "27701", lat: 35.994, lon: -78.899 }, { n: "Raleigh, NC", z: "27601", lat: 35.772, lon: -78.638 }, { n: "Boston, MA", z: "02108", lat: 42.357, lon: -71.064 }];
    render(<LocationPicker hubs={hubs} onChange={() => {}} />);
    const w = screen.getByText(/search areas overlap about/);
    expect(w.textContent).toMatch(/Durham, NC and Raleigh, NC are \d+ mi apart/);
    expect(screen.queryAllByText(/search areas overlap about/).length).toBe(1);
    cleanup();
  });
});
