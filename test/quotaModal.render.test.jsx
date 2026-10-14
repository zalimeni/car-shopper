// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { QuotaGauge, QuotaModal } = await import("../src/App.jsx");
const { summarize } = await import("../src/quota.js");

const KEYS = [{ key: "sk-aaaa1111", label: "Personal" }, { key: "sk-bbbb2222", label: "Spare" }];
const FUTURE = new Date(Date.now() + 10 * 86400000).toISOString();
const store = { snaps: { "1111": { remaining: 0, limit: 500, exhausted: true, reset: FUTURE, at: "2026-10-14T01:00:00Z" }, "2222": { remaining: 350, limit: 500, reset: FUTURE, at: "2026-10-14T01:00:00Z" } }, lastSync: { calls: 14, at: "x" } };
const data = (mcQuota) => ({
  profiles: [{ id: "a", active: true }, { id: "b", active: true }, { id: "c", active: true }, { id: "d", active: false }],
  settings: { hubs: [{ n: "Durham, NC", z: "27701" }, { n: "Boston, MA", z: "02108" }], marketcheckKeys: KEYS, mcQuota: mcQuota },
});
const sumOf = (d) => summarize(d.settings.marketcheckKeys, d.settings.mcQuota);

describe("QuotaGauge", () => {
  it("is a button whose label says how many calls are left", () => {
    const d = data(store);
    render(<QuotaGauge summary={sumOf(d)} onClick={() => {}} />);
    const b = screen.getByRole("button");
    expect(b.getAttribute("aria-label")).toMatch(/350 calls left \(35%\)/);
    cleanup();
  });
  it("says 'not measured' before anything is known, and opens on click", () => {
    const onClick = vi.fn();
    render(<QuotaGauge summary={sumOf(data(null))} onClick={onClick} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/not measured/);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
    cleanup();
  });
});

describe("QuotaModal", () => {
  const open = (d, extra) => render(<QuotaModal data={d} summary={sumOf(d)} onClose={() => {}} {...(extra || {})} />);

  it("shows total capacity, each key in order with its state, and the next reset", () => {
    const { container } = open(data(store));
    const text = container.textContent;
    expect(text).toMatch(/350 of 1,000 calls left/);
    expect(text).toMatch(/2 keys, used in order/);
    const rows = [...container.querySelectorAll("tbody tr")].slice(0, 2).map((r) => r.textContent);
    expect(rows[0]).toMatch(/Personal.*…1111.*0.*\/ 500.*spent/);
    expect(rows[1]).toMatch(/Spare.*…2222.*350.*\/ 500.*in use/);
    cleanup();
  });
  it("estimates syncs from the CURRENT active profiles x locations (3 x 2 x 2 = 12 calls min)", () => {
    const { container } = open(data(store));
    const text = container.textContent;
    expect(text).toMatch(/3 active profiles × 2 locations × 2 car types/);
    expect(text).toMatch(/12–48 calls/);
    expect(text).toMatch(/last full sync actually used 14/);
    expect(text).toMatch(/≈ 25 syncs left at your last sync's cost/); // floor(350/14)
    cleanup();
  });
  it("lists what each kind of call costs", () => {
    const { container } = open(data(store));
    const t = container.textContent;
    expect(t).toMatch(/Sync of one location6–24/);
    expect(t).toMatch(/Price Check → live market4–16/);
    expect(t).not.toMatch(/Refresh/);
    cleanup();
  });
  it("before any measurement it says so and still shows the cost table", () => {
    const { container } = open(data(null));
    expect(container.textContent).toMatch(/Not measured yet — it fills in after your next sync/);
    expect(container.textContent).toMatch(/What each call costs/);
    cleanup();
  });
  it("never makes an API call: no fetch on render, and no control that could spend quota", () => {
    const spy = vi.fn(); const orig = global.fetch; global.fetch = spy;
    const { container } = open(data(store));
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Close"]);
    expect(spy).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/never makes API calls/);
    global.fetch = orig;
    cleanup();
  });
  it("Close and Escape both close it", () => {
    const onClose = vi.fn();
    open(data(store), { onClose });
    fireEvent.click(screen.getByText("Close"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup();
  });
});
