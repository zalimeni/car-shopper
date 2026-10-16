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


const { restoreQueue, trimQueue, loadLegacyQueue, pruneQueue } = await import("../src/App.jsx");

describe("candidate review queue in the synced app state", () => {
  const data = (over) => Object.assign({ listings: [{ vin: "w1", status: "watch" }, { vin: "R1", status: "rejected" }], skipped: [{ vin: "S1" }], criteria: [] }, over);
  it("restores the saved queue minus cars since approved, rejected/sold or skipped", () => {
    const r = restoreQueue(data({ candidates: [{ vin: "W1" }, { vin: "R1" }, { vin: "S1" }, { vin: "KEEP" }] }), []);
    expect(r.queue.map((c) => c.vin)).toEqual(["KEEP"]);
    expect(r.data.candidates).toBe(r.queue);
    expect(r.changed).toBe(true); // pruned -> write back
  });
  it("an unchanged queue isn't written back", () => {
    const r = restoreQueue(data({ candidates: [{ vin: "A" }] }), []);
    expect(r.changed).toBe(false);
  });
  it("merges a legacy per-device queue once, deduped", () => {
    const r = restoreQueue(data({ candidates: [{ vin: "A" }] }), [{ vin: "a" }, { vin: "B" }, { vin: "S1" }]);
    expect(r.queue.map((c) => c.vin)).toEqual(["A", "B"]);
    expect(r.changed).toBe(true);
  });
  it("counts and unflags what the scheduled sync added, and drains legacy pendingCandidates", () => {
    const r = restoreQueue(data({ candidates: [{ vin: "A" }, { vin: "N1", fromScheduled: true, scores: {} }], pendingCandidates: [{ vin: "N2", scores: {} }, { vin: "A" }] }), []);
    expect(r.queue.map((c) => c.vin)).toEqual(["A", "N1", "N2"]);
    expect(r.scheduled).toBe(2);
    expect(r.queue.some((c) => c.fromScheduled)).toBe(false);
    expect(r.queue[1]._candidate).toBe(true);
    expect("pendingCandidates" in r.data).toBe(false);
  });
  it("keeps the newest 300", () => {
    const q = trimQueue(Array.from({ length: 305 }, (_, i) => ({ vin: "V" + i })));
    expect([q.length, q[0].vin]).toEqual([300, "V5"]);
  });
  it("reads a legacy queue from localStorage, else sessionStorage", () => {
    localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem("cs-candidates", JSON.stringify([{ vin: "OLD" }]));
    expect(loadLegacyQueue()).toEqual([{ vin: "OLD" }]);
    localStorage.setItem("cs-candidates", JSON.stringify([{ vin: "LOCAL" }]));
    expect(loadLegacyQueue()).toEqual([{ vin: "LOCAL" }]);
  });
  it("pruneQueue matches VINs case-insensitively", () => {
    expect(pruneQueue([{ vin: "W1" }, { vin: "x" }], data({})).map((c) => c.vin)).toEqual(["x"]);
  });
});
