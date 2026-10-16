// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

describe("sign-in: link or code from the same email", () => {
  function setup(verifyResult) {
    const calls = { otp: [], verify: [] };
    supabaseMock = Object.assign(mkSupabase(async () => ({ data: { session: null } })), {});
    supabaseMock.auth.signInWithOtp = async (a) => { calls.otp.push(a); return { error: null }; };
    supabaseMock.auth.verifyOtp = async (a) => { calls.verify.push(a); return verifyResult || { error: null }; };
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    return calls;
  }
  async function sendTo(email) {
    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: email } });
    fireEvent.click(screen.getByText("Email me a sign-in link & code"));
    return screen.findByLabelText("Sign-in code");
  }
  it("after sending, asks for the code and verifies it in this window", async () => {
    const calls = setup();
    const codeBox = await sendTo("me@x.com");
    expect(calls.otp[0]).toMatchObject({ email: "me@x.com" });
    fireEvent.change(codeBox, { target: { value: "12 34-56" } }); // digits only
    expect(codeBox.value).toBe("123456");
    fireEvent.click(screen.getByText("Sign in with code"));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.verify[0]).toEqual({ email: "me@x.com", token: "123456", type: "email" });
  });
  it("a bad code keeps you on the code step with a clear message", async () => {
    setup({ error: { message: "Token has expired or is invalid" } });
    const codeBox = await sendTo("me@x.com");
    fireEvent.change(codeBox, { target: { value: "000000" } });
    fireEvent.click(screen.getByText("Sign in with code"));
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(screen.getByLabelText("Sign-in code")).toBeTruthy();
  });
  it("the code button waits for at least 6 digits", async () => {
    setup();
    const codeBox = await sendTo("me@x.com");
    fireEvent.change(codeBox, { target: { value: "123" } });
    expect(screen.getByText("Sign in with code").closest("button").disabled).toBe(true);
  });
});
