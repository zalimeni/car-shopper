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

const { HomeBasePicker } = await import("../src/App.jsx");
const FILE = readFileSync(process.cwd() + "/public/locations.txt", "utf8");

function Harness({ start, onSet }) {
  const [home, setHome] = useState(start === undefined ? { n: "Durham, NC", z: "27701", lat: 35.994, lon: -78.8986 } : start);
  return <HomeBasePicker value={home} onChange={(h) => { onSet(h); setHome(h); }} />;
}

beforeAll(() => { global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => FILE })); });

describe("HomeBasePicker", () => {
  it("shows the current home base and one search box", () => {
    const { container } = render(<Harness onSet={() => {}} />);
    expect(container.textContent).toMatch(/Durham, NC 27701/);
    expect(container.querySelectorAll("input").length).toBe(1);
    cleanup();
  });
  it("says it's needed when unset", () => {
    const { container } = render(<Harness start={null} onSet={() => {}} />);
    expect(container.textContent).toMatch(/Not set — distance flags need it/);
    cleanup();
  });
  it("picking a suggestion replaces the home base, with coordinates", async () => {
    let last;
    const { container } = render(<Harness onSet={(h) => { last = h; }} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "louisville ky" } });
    fireEvent.mouseDown(await screen.findByText("Louisville, KY"));
    await waitFor(() => expect(last).toBeTruthy());
    expect(last).toMatchObject({ n: "Louisville, KY", st: "KY" });
    expect(typeof last.lat).toBe("number");
    expect(container.textContent).toMatch(/Louisville, KY/);
    cleanup();
  });
  it("× clears it", () => {
    let last = "untouched";
    render(<Harness onSet={(h) => { last = h; }} />);
    fireEvent.click(screen.getByTitle("Clear home base"));
    expect(last).toBeNull();
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
    expect(last.st).toBe("TX");
    cleanup();
  });
  it("still accepts a bare ZIP when the location file can't load", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }));
    vi.resetModules();
    const { HomeBasePicker: Fresh } = await import("../src/App.jsx");
    let last;
    function H() { const [h, setH] = useState(null); return <Fresh value={h} onChange={(x) => { last = x; setH(x); }} />; }
    render(<H />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await screen.findByText(/couldn't load/);
    fireEvent.change(input, { target: { value: "27701" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(last).toEqual({ n: "27701", z: "27701" });
    cleanup();
  });
});
