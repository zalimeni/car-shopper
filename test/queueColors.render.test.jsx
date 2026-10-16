// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));


const { fillQueueColors } = await import("../src/App.jsx");

describe("fillQueueColors (queued candidates get colors found later)", () => {
  const cache = { V3: { color: "Phantom Black Pearl", baseColor: "Black", at: "2026-10-16T00:00:00Z" }, V4: { color: null, at: "2026-10-16T00:00:00Z" } };
  it("takes a color from this sync's results, then from remembered decodes; never overwrites", () => {
    const queue = [{ vin: "v1" }, { vin: "V2", color: "Blue", baseColor: "Blue" }, { vin: "V3" }, { vin: "V4" }, { vin: "V5" }];
    const fresh = [{ vin: "V1", color: "Shimmering Silver Metallic", baseColor: "Silver", colorSource: "neovin" }, { vin: "V2", color: "Red", baseColor: "Red" }];
    const out = fillQueueColors(queue, fresh, cache);
    expect(out[0]).toMatchObject({ color: "Shimmering Silver Metallic", baseColor: "Silver", colorSource: "neovin" });
    expect(out[1]).toBe(queue[1]); // already had one
    expect(out[2]).toMatchObject({ color: "Phantom Black Pearl", baseColor: "Black", colorSource: "neovin" });
    expect(out[3]).toBe(queue[3]); // decoded, none found
    expect(out[4]).toBe(queue[4]); // nothing known yet
  });
});
