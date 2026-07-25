// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

let handlers = [];
const mkSupabase = (getSessionImpl) => ({
  auth: {
    getSession: getSessionImpl,
    onAuthStateChange: (cb) => { handlers.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
  },
});
let supabaseMock;
let storedMock = null;
vi.mock("../src/supabaseClient", () => ({ get supabase() { return supabaseMock; }, storedSession: () => storedMock }));
global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ authorized: true }) }));

const AuthGate = (await import("../src/Auth.jsx")).default;

beforeEach(() => { handlers = []; cleanup(); });

describe("AuthGate does not hang when getSession() stalls", () => {
  it("REPRO: with getSession hanging and no auth event, it must not sit on Loading forever", async () => {
    supabaseMock = mkSupabase(() => new Promise(() => {})); // never resolves
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    // Give it a moment; the fix should let onAuthStateChange / a timeout unstick it.
    await new Promise((r) => setTimeout(r, 200));
    // Simulate the auth client delivering the initial session via the listener,
    // as supabase-js does (INITIAL_SESSION) even when getSession()'s promise stalls.
    handlers.forEach((h) => h("INITIAL_SESSION", { user: { id: "u1", email: "x@y.z" } }));
    await screen.findByText("APPBODY", {}, { timeout: 3000 });
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
