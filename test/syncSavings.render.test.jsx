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

const { syncWarning, liveSearchHub, syncProgressText } = await import("../src/App.jsx");
const { searchSig } = await import("../src/syncPlan.js");

const NOW = Date.parse("2026-10-14T12:00:00Z");
const PROFS = [{ id: "a", active: true, params: { make: "Toyota", model: "RAV4" } }, { id: "b", active: true, params: { make: "Honda", model: "CR-V" } }];
const OPTS = { excludeSalt: true, franchiseOnly: false };
const meta = (count) => ({ fullAt: "2026-10-14T10:00:00Z", lastAt: "2026-10-14T10:00:00Z", count: count, countSig: searchSig(PROFS[count === 120 ? 0 : 1], OPTS), sig: searchSig(PROFS[count === 120 ? 0 : 1], OPTS) });
const base = (over) => Object.assign({
  lastSynced: "2026-10-14T10:00:00Z",
  profiles: PROFS,
  listings: [{ mcSeen: "2026-10-11" }, { mcSeen: "2026-10-12" }],
  settings: { homeBase: { n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }, marketcheckKeys: [{ key: "sk-aaaa1111" }],
    mcProfiles: { a: meta(120), b: meta(30) },
    mcQuota: { snaps: { "1111": { remaining: 300, limit: 500, reset: "2026-11-01T00:00:00Z", at: "x" } }, lastSync: { calls: 9, at: "x" } } },
}, over || {});

describe("syncWarning (confirm before a redundant sync)", () => {
  it("warns within 6 hours, with the full-refresh cost, calls left and MarketCheck's freshness", () => {
    const w = syncWarning(base(), NOW);
    expect(w).toMatch(/last sync was 2 hours ago/);
    expect(w).toMatch(/newest data on your listings is from 2026-10-12/);
    expect(w).toMatch(/It will use 4 MarketCheck calls \(300 left this month\)\./); // 120 cars = 3 + 30 cars = 1
    expect(w).toMatch(/Sync anyway\?/);
  });
  it("says nothing after 6 hours, or before the first sync", () => {
    expect(syncWarning(base({ lastSynced: "2026-10-14T05:00:00Z" }), NOW)).toBeNull();
    expect(syncWarning(base({ lastSynced: null }), NOW)).toBeNull();
  });
  it("gives a range for profiles whose match count isn't known yet", () => {
    const d = base(); d.settings = Object.assign({}, d.settings, { mcProfiles: {} });
    expect(syncWarning(d, NOW)).toMatch(/It will use 2–20 MarketCheck calls/);
  });
  it("counts minutes when it was very recent", () => {
    expect(syncWarning(base({ lastSynced: "2026-10-14T11:50:00Z" }), NOW)).toMatch(/10 min ago/);
  });
});

describe("liveSearchHub (Price Check searches around the home base)", () => {
  it("uses the home base", () => {
    expect(liveSearchHub({ homeBase: { n: "Durham, NC", z: "27701", lat: 35.99, lon: -78.9 } })).toMatchObject({ z: "27701", lat: 35.99 });
    expect(liveSearchHub({ homeBase: { z: "27701" } }).z).toBe("27701");
  });
  it("is null without one", () => {
    expect(liveSearchHub({ homeBase: null })).toBeNull();
    expect(liveSearchHub({})).toBeNull();
  });
});

describe("syncProgressText", () => {
  it("counts steps and names the profile", () => {
    expect(syncProgressText({ done: 1, total: 3, label: "Bolt EV", listings: [1, 2] })).toBe("Searching… 1/3 · Bolt EV · 2 found");
  });
});
