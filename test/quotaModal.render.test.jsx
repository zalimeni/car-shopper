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
const { searchSig } = await import("../src/syncPlan.js");

const KEYS = [{ key: "sk-aaaa1111", label: "Personal" }, { key: "sk-bbbb2222", label: "Spare" }];
const FUTURE = new Date(Date.now() + 10 * 86400000).toISOString();
const P = (id, active) => ({ id, name: "Car " + id, active, params: { make: "M", model: id } });
const PROFILES = [P("a", true), P("b", true), P("c", true), P("d", false)];
const store = { snaps: { "1111": { remaining: 0, limit: 500, exhausted: true, reset: FUTURE, at: "2026-10-14T01:00:00Z" }, "2222": { remaining: 350, limit: 500, reset: FUTURE, at: "2026-10-14T01:00:00Z" } }, lastSync: { calls: 14, at: "x" } };
const OPTS = { excludeSalt: true, franchiseOnly: false };
// a: 120 matching cars (3 calls); b: 30 (1 call); c: never synced (1–10).
const META = {
  a: { fullAt: "2026-10-14T01:00:00Z", lastAt: "2026-10-14T01:00:00Z", sig: searchSig(PROFILES[0], OPTS), count: 120, countSig: searchSig(PROFILES[0], OPTS) },
  b: { fullAt: "2026-10-14T01:00:00Z", lastAt: "2026-10-14T01:00:00Z", sig: searchSig(PROFILES[1], OPTS), count: 30, countSig: searchSig(PROFILES[1], OPTS) },
};
const data = (mcQuota) => ({
  profiles: PROFILES, listings: [],
  settings: { homeBase: { n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }, marketcheckKeys: KEYS, mcQuota: mcQuota, mcProfiles: META },
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
  it("estimates a sync from each active profile's own nationwide search", () => {
    const { container } = open(data(store));
    const text = container.textContent;
    expect(text).toMatch(/Each active profile is one nationwide search \(salt-belt states left out\)/);
    expect(text).toMatch(/fully refreshes them all: one call per 50 matching cars, so 5–14 calls/); // 3 + 1 + (1–10)
    expect(text).toMatch(/Car a120\D*3 calls/);
    expect(text).toMatch(/Car c—1–10 calls\s*never/);
    expect(text).not.toMatch(/Car d/); // inactive
    expect(text).toMatch(/last sync used 14 calls/);
    expect(text).toMatch(/≈ 25–70 full syncs left/); // 350 / 14 .. 350 / 5
    cleanup();
  });
  it("flags a profile whose count is high", () => {
    const d = data(store);
    d.settings.mcProfiles = Object.assign({}, META, { a: Object.assign({}, META.a, { count: 1097 }) });
    const { container } = open(d);
    expect(container.textContent).toMatch(/Car a1,097/);
    cleanup();
  });
  it("lists what each kind of call costs", () => {
    const { container } = open(data(store));
    const t = container.textContent;
    expect(t).toMatch(/↻ Sync \(full refresh of every active profile\)5–14/);
    expect(t).toMatch(/Check a profile's match count1/);
    expect(t).toMatch(/Price Check → live market1–4/);
    expect(t).toMatch(/Daily scheduled sync.*full refresh every 3 days/);
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
