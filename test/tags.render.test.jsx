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


const { TagEditor } = await import("../src/App.jsx");

function Harness({ start, known, onSet }) {
  const [tags, setTags] = useState(start);
  return <TagEditor tags={tags} known={known} onChange={(t) => { onSet(t); setTags(t); }} />;
}

describe("TagEditor", () => {
  it("shows tags as chips and removes one with ×", () => {
    let last;
    render(<Harness start={["Called dealer", "Carfax"]} known={[]} onSet={(t) => { last = t; }} />);
    expect(screen.getByText(/Called dealer/)).toBeTruthy();
    fireEvent.click(screen.getByTitle("Remove tag Called dealer"));
    expect(last).toEqual(["Carfax"]);
    cleanup();
  });
  it("adds a new tag with Enter", () => {
    let last;
    render(<Harness start={[]} known={[]} onSet={(t) => { last = t; }} />);
    fireEvent.click(screen.getByText("+ tag"));
    const box = screen.getByLabelText("Tag");
    fireEvent.change(box, { target: { value: "  test   drive booked " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(last).toEqual(["test drive booked"]);
    cleanup();
  });
  it("suggests tags already in use — one tap adds it, with its spelling", () => {
    let last;
    render(<Harness start={["Carfax"]} known={["Carfax", "Called dealer", "Appraisal"]} onSet={(t) => { last = t; }} />);
    fireEvent.click(screen.getByText("+ tag"));
    // already-present tags aren't suggested; typing narrows the rest
    expect(screen.queryAllByText("Carfax").length).toBe(0);
    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "call" } });
    expect(screen.queryByText("Appraisal")).toBeNull();
    fireEvent.click(screen.getByText("Called dealer"));
    expect(last).toEqual(["Carfax", "Called dealer"]);
    cleanup();
  });
  it("typing an existing tag in another case doesn't duplicate it", () => {
    let calls = 0;
    render(<Harness start={["Called dealer"]} known={["Called dealer"]} onSet={() => { calls++; }} />);
    fireEvent.click(screen.getByText("+ tag"));
    const box = screen.getByLabelText("Tag");
    fireEvent.change(box, { target: { value: "CALLED DEALER" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(calls).toBe(0);
    cleanup();
  });
});
