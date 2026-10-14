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
const { summarize, planSig } = await import("../src/quota.js");

const KEYS = [{ key: "sk-aaaa1111", label: "Personal" }, { key: "sk-bbbb2222", label: "Spare" }];
const FUTURE = new Date(Date.now() + 10 * 86400000).toISOString();
const PROFILES = [{ id: "a", active: true }, { id: "b", active: true }, { id: "c", active: true }, { id: "d", active: false }];
const HUBS = [{ n: "Durham, NC", z: "27701" }, { n: "Boston, MA", z: "02108" }]; // ZIP-only: no nationwide search
const store = { snaps: { "1111": { remaining: 0, limit: 500, exhausted: true, reset: FUTURE, at: "2026-10-14T01:00:00Z" }, "2222": { remaining: 350, limit: 500, reset: FUTURE, at: "2026-10-14T01:00:00Z" } }, lastSync: { calls: 14, at: "x", plan: planSig(PROFILES.filter((p) => p.active), HUBS) } };
const data = (mcQuota) => ({
  profiles: PROFILES,
  settings: { hubs: HUBS, marketcheckKeys: KEYS, mcQuota: mcQuota },
});
const sumOf = (d) => summarize(d.settings.marketcheckKeys, d.settings.mcQuota);

describe("QuotaGauge", () => {
  it("is a button whose label says how many calls are left", () => {
    const d = data(store);
    render(<QuotaGauge summary={sumOf(d)} onClick={() => {}} />);
    const b = screen.getByRole("button");
    expect(b.getAttribute("aria-label")).toMatch(/65% used, 350 calls left/);
    cleanup();
  });
  it("counts never-used keys at 500 each, and opens on click", () => {
    const onClick = vi.fn();
    render(<QuotaGauge summary={sumOf(data(null))} onClick={onClick} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/0% used, 1,000 calls left/);
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
  it("estimates syncs from the CURRENT active profiles (all in one search) x locations", () => {
    const { container } = open(data(store));
    const text = container.textContent;
    // 3 active profiles with no powertrain filter -> one merged search x 2 locations
    expect(text).toMatch(/3 active profiles share one search × 2 locations/);
    expect(text).toMatch(/nationwide search needs every location to have coordinates/);
    expect(text).toMatch(/2–20 calls/); // floor 1x2; ceiling 10 pages (500-row cap) x 2
    expect(text).toMatch(/last full sync actually used 14/);
    expect(text).toMatch(/≈ 25 syncs left at your last sync's cost/); // floor(350/14)
    cleanup();
  });
  it("explains the nationwide search when every location has coordinates", () => {
    const d = data(null);
    d.settings.hubs = [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }, { n: "Boston, MA", z: "02108", lat: 42.36, lon: -71.06 }];
    const { container } = open(d);
    expect(container.textContent).toMatch(/share one search, run nationwide and kept to your 2 locations' radii/);
    expect(container.textContent).toMatch(/No sync of your current profiles and locations recorded yet/);
    cleanup();
  });
  it("lists what each kind of call costs", () => {
    const { container } = open(data(store));
    const t = container.textContent;
    expect(t).toMatch(/Sync of one location1–10/);
    expect(t).toMatch(/Price Check → live market1–4/);
    expect(t).toMatch(/Daily scheduled sync.*≈ 420 \/ month/); // last full sync 14 x 30
    expect(t).not.toMatch(/Refresh/);
    cleanup();
  });
  it("before any measurement it presumes the free plan per key and says so", () => {
    const { container } = open(data(null));
    expect(container.textContent).toMatch(/1,000 of 1,000 calls left/);
    expect(container.textContent).toMatch(/Includes 2 unused keys counted at 500 \(the free plan\)/);
    expect(container.textContent).toMatch(/not used yet — assumed 500, confirmed on first use/);
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
