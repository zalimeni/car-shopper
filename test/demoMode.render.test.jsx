// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// /?demo end to end: the published snapshot loads with no session, the welcome
// shows once, edits stay in memory, ↻ Sync is simulated (held-back cars with
// their scores, a price drop, a car gone), and no /api call leaves the browser.
window.history.replaceState(null, "", "/?demo#results");

const car = (id, o) => Object.assign({ id: id, vin: "VIN000000000000" + id, year: 2021, make: "Subaru", model: "Outback", vehicle: "Subaru Outback", trim: "Premium",
  status: "watch", source: "marketcheck", profileId: "p1", price: 22000, miles: 40000, dealer: "Dealer " + id, addedDate: "2026-10-01", lastSeen: "2026-10-30", lastChecked: "2026-10-30" }, o || {});
const snapshot = {
  demoVersion: 1, exportedAt: "2026-10-31T12:00:00Z",
  data: {
    version: 9, onboarded: true, autoScore: true,
    profiles: [{ id: "p1", name: "Outback", role: "SUV", active: true, params: { make: "Subaru", model: "Outback" } }],
    criteria: [{ id: "price", name: "Price", weight: 25 }],
    listings: [car("1", { dom: 5 }), car("2", { dom: 8 }), car("3", { dom: 12 }), car("4", { dom: 200, dealer: "Old Lot Motors" })],
    candidates: [], skipped: [], settings: { homeBase: { n: "Durham, NC", lat: 35.99, lon: -78.9 } },
    lastSynced: "2026-10-31T09:00:00Z",
  },
  pool: [car("9", { trim: "Limited", dealer: "Pool Dealer", scores: { price: 9 }, scoredAt: "2026-10-30T10:00:00Z", aiSummary: "Clean one-owner car" })],
};

const writes = [];
const chain = (table) => { const c = {}; ["select", "eq", "order", "limit"].forEach((m) => { c[m] = () => c; });
  c.maybeSingle = async () => (table === "demo_snapshot" ? { data: { id: 1, data: snapshot }, error: null } : (writes.push(table), { data: null, error: null }));
  c.upsert = c.update = c.insert = c.delete = () => { writes.push(table); return c; };
  return c; };
vi.mock("../src/supabaseClient", () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  from: (t) => chain(t),
} }));

const apiCalls = [];
window.fetch = async (u) => { apiCalls.push(String(u)); return new Response("{}", { status: 200 }); };

const { installFetchGuard, setDemoDelay } = await import("../src/demoRuntime.js");
installFetchGuard();
setDemoDelay(0);
const { DemoShell } = await import("../src/Demo.jsx");
const App = (await import("../src/App.jsx")).default;

describe("demo mode", () => {
  it("loads the snapshot, welcomes once, simulates a sync, and never calls out", async () => {
    localStorage.clear();
    render(React.createElement(DemoShell, null, React.createElement(App)));
    const welcome = await screen.findByRole("dialog", { name: "Welcome" }, { timeout: 4000 });
    expect(within(welcome).getByText("How this app uses Supabase")).toBeTruthy();
    expect(within(welcome).getByText("— Michael")).toBeTruthy();
    fireEvent.click(within(welcome).getByText("Explore on my own"));
    expect(screen.queryByRole("dialog", { name: "Welcome" })).toBeNull();
    expect(localStorage.getItem("cs-demo-welcomed")).toBe("1");
    expect(screen.getByText("Demo · not saved")).toBeTruthy();

    fireEvent.click(screen.getByText("↻ Sync"));
    await screen.findByText(/Demo sync/, {}, { timeout: 4000 });
    // The held-back car shows up as a candidate, still scored.
    await screen.findAllByText(/Pool Dealer/);
    expect(screen.getAllByText(/Clean one-owner car/).length).toBeGreaterThan(0);

    // A blocked live call explains itself.
    await window.fetch("/api/pricecomps", { method: "POST" });
    await screen.findByText(/Live comparables are off in the demo/);

    await waitFor(() => expect(apiCalls).toEqual([]));
    expect(writes).toEqual([]); // nothing written to Supabase
  });
});
