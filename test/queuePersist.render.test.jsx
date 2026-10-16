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


const { loadQueue, saveQueue, pruneQueue } = await import("../src/App.jsx");

describe("candidate queue kept on the device", () => {
  it("round-trips through localStorage, keeping the newest 300", () => {
    localStorage.clear(); sessionStorage.clear();
    saveQueue(Array.from({ length: 305 }, (_, i) => ({ vin: "V" + i })));
    const q = loadQueue();
    expect(q.length).toBe(300);
    expect(q[0].vin).toBe("V5");
    expect(q[299].vin).toBe("V304");
  });
  it("picks up a queue saved in sessionStorage before the move", () => {
    localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem("cs-candidates", JSON.stringify([{ vin: "OLD" }]));
    expect(loadQueue()).toEqual([{ vin: "OLD" }]);
  });
  it("drops cars since approved, rejected/sold or skipped", () => {
    const data = { listings: [{ vin: "w1", status: "watch" }, { vin: "R1", status: "rejected" }], skipped: [{ vin: "S1" }] };
    expect(pruneQueue([{ vin: "W1" }, { vin: "R1" }, { vin: "S1" }, { vin: "NEW" }, { vin: "" }], data).map((c) => c.vin)).toEqual(["NEW", ""]);
  });
});
