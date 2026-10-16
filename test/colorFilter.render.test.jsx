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


const { ColorFilter } = await import("../src/App.jsx");

describe("ColorFilter (profile editor)", () => {
  const facet = { counts: { Black: 261, Gray: 204, White: 186 }, unlisted: 34, at: "2026-10-16T02:00:00Z" };
  it("lists the profile's colors with counts, most common first, and the no-color count", () => {
    const { container } = render(<ColorFilter facet={facet} excluded={[]} includeUnlisted={true} onChange={() => {}} />);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Black · 261", "Gray · 204", "White · 186"]);
    expect(container.textContent).toMatch(/Include cars with no color listed \(34\)/);
    cleanup();
  });
  it("tapping a color hides it; tapping again un-hides", () => {
    let last;
    const { rerender } = render(<ColorFilter facet={facet} excluded={[]} includeUnlisted={true} onChange={(c) => { last = c; }} />);
    fireEvent.click(screen.getByText("Black · 261"));
    expect(last).toEqual({ excludeColors: ["Black"], includeUnlistedColor: true });
    rerender(<ColorFilter facet={facet} excluded={["Black"]} includeUnlisted={true} onChange={(c) => { last = c; }} />);
    expect(screen.getByText("Black · 261").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Black · 261"));
    expect(last.excludeColors).toEqual([]);
    cleanup();
  });
  it("the no-color checkbox defaults on and can be turned off", () => {
    let last;
    render(<ColorFilter facet={facet} excluded={["Gold"]} onChange={(c) => { last = c; }} />);
    const box = screen.getByRole("checkbox");
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(last).toEqual({ excludeColors: ["Gold"], includeUnlistedColor: false });
    expect(screen.getByText("Gold · 0")).toBeTruthy(); // an excluded color the facet lacks stays un-excludable
    cleanup();
  });
  it("before a facet exists it offers the common colors", () => {
    const { container } = render(<ColorFilter facet={null} excluded={[]} onChange={() => {}} />);
    expect(container.textContent).toMatch(/Save the profile to see the colors/);
    expect(screen.getByText("Gold")).toBeTruthy();
    cleanup();
  });
});
