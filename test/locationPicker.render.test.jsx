// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { LocationPicker } = await import("../src/App.jsx");
const FILE = readFileSync(process.cwd() + "/public/locations.txt", "utf8");

// Legacy-shaped saved hubs (label + zip, no state field), in the "wrong" order.
const LEGACY = [{ n: "Durham NC", z: "27701", lat: 35.994, lon: -78.8986 }, { n: "Boston MA", z: "02101", lat: 42.36, lon: -71.06 }];

function Harness({ onSet }) {
  const [hubs, setHubs] = useState(LEGACY);
  return <LocationPicker hubs={hubs} onChange={(h) => { onSet(h); setHubs(h); }} />;
}
const chipText = (c) => [...c.querySelectorAll("span[style*='inline-flex']")].map((e) => e.textContent.replace("×", ""));

beforeAll(() => { global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => FILE })); });

describe("LocationPicker", () => {
  it("shows saved locations sorted by state, with no separate name/zip fields", () => {
    const { container } = render(<Harness onSet={() => {}} />);
    expect(chipText(container)).toEqual(["Boston, MA02101", "Durham, NC27701"]);
    expect(container.querySelectorAll("input").length).toBe(1);
    cleanup();
  });

  it("suggests from the flat file and adds the pick, sorted into place and with coordinates", async () => {
    let last;
    const { container } = render(<Harness onSet={(h) => { last = h; }} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "louisville ky" } });
    const opt = await screen.findByText("Louisville, KY");
    fireEvent.mouseDown(opt);
    await waitFor(() => expect(last).toBeTruthy());
    expect(last.map((h) => h.z === "27701" ? "NC" : h.z === "02101" ? "MA" : h.st)).toEqual(["KY", "MA", "NC"]);
    expect(last[0]).toMatchObject({ n: "Louisville, KY", st: "KY" });
    expect(typeof last[0].lat).toBe("number");
    expect(chipText(container)[0]).toMatch(/^Louisville, KY/);
    cleanup();
  });

  it("refuses a duplicate (even under a different label) and says so", async () => {
    let calls = 0;
    render(<Harness onSet={() => { calls++; }} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "27701" } });
    fireEvent.mouseDown(await screen.findByText("Durham, NC 27701"));
    expect(await screen.findByText(/already in your list/)).toBeTruthy();
    expect(calls).toBe(0);
    cleanup();
  });

  it("removes a location with ×", () => {
    let last;
    const { container } = render(<Harness onSet={(h) => { last = h; }} />);
    fireEvent.click(screen.getByTitle("Remove Durham NC"));
    expect(last.map((h) => h.z)).toEqual(["02101"]);
    expect(chipText(container)).toEqual(["Boston, MA02101"]);
    cleanup();
  });

  it("supports keyboard: arrows + Enter pick a suggestion", async () => {
    let last;
    render(<Harness onSet={(h) => { last = h; }} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "austin" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(last).toBeTruthy());
    expect(last.some((h) => h.n === "Austin, TX")).toBe(true);
    cleanup();
  });

  it("still accepts a bare ZIP when the location file can't load", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }));
    vi.resetModules();
    let last;
    const { LocationPicker: Fresh } = await import("../src/App.jsx");
    function H() { const [h, s] = useState([]); return <Fresh hubs={h} onChange={(x) => { last = x; s(x); }} />; }
    render(<H />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(await screen.findByText(/couldn't load/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "27701" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(last).toEqual([{ n: "27701", z: "27701" }]));
    cleanup();
  });
});
