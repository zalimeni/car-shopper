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

describe("sign-in: tap the link or paste it", () => {
  const LINK = "https://proj.supabase.co/auth/v1/verify?token=abc123hash&type=magiclink&redirect_to=https://app";
  function setup(result) {
    const calls = { otp: [], verify: [], setSession: [] };
    supabaseMock = mkSupabase(async () => ({ data: { session: null } }));
    supabaseMock.auth.signInWithOtp = async (a) => { calls.otp.push(a); return { error: null }; };
    supabaseMock.auth.verifyOtp = async (a) => { calls.verify.push(a); return result || { error: null }; };
    supabaseMock.auth.setSession = async (a) => { calls.setSession.push(a); return result || { error: null }; };
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    return calls;
  }
  async function sendTo(email) {
    fireEvent.change(await screen.findByPlaceholderText("you@example.com"), { target: { value: email } });
    fireEvent.click(screen.getByText("Email me a sign-in link"));
    return screen.findByLabelText("Sign-in link");
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("invite-only: never asks Supabase to create an account, and says so for an unknown email", async () => {
    const calls = { otp: [] };
    supabaseMock = mkSupabase(async () => ({ data: { session: null } }));
    supabaseMock.auth.signInWithOtp = async (a) => { calls.otp.push(a); return { error: { code: "otp_disabled", message: "Signups not allowed for otp" } }; };
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    fireEvent.change(await screen.findByPlaceholderText("you@example.com"), { target: { value: "new@x.com" } });
    fireEvent.click(screen.getByText("Email me a sign-in link"));
    expect(await screen.findByText(/invite-only/)).toBeTruthy();
    expect(calls.otp[0].options.shouldCreateUser).toBe(false);
  });
  it("a pasted emailed link is verified in this window (token hash)", async () => {
    const calls = setup();
    const box = await sendTo("me@x.com");
    expect(calls.otp[0]).toMatchObject({ email: "me@x.com", options: { shouldCreateUser: false } });
    fireEvent.change(box, { target: { value: LINK } });
    fireEvent.click(screen.getByText("Sign in with link"));
    await flush();
    expect(calls.verify[0]).toEqual({ token_hash: "abc123hash", type: "magiclink" });
  });
  it("a pasted post-sign-in Safari URL sets the session directly", async () => {
    const calls = setup();
    const box = await sendTo("me@x.com");
    fireEvent.change(box, { target: { value: "https://app/#access_token=AT&refresh_token=RT" } });
    fireEvent.click(screen.getByText("Sign in with link"));
    await flush();
    expect(calls.setSession[0]).toEqual({ access_token: "AT", refresh_token: "RT" });
  });
  it("something that isn't the link says what to copy", async () => {
    const calls = setup();
    const box = await sendTo("me@x.com");
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Sign in with link"));
    expect(await screen.findByText(/Copy the link itself/)).toBeTruthy();
    expect(calls.verify.length).toBe(0);
  });
  it("a used or expired link explains that opening it uses it up", async () => {
    setup({ error: { message: "Email link is invalid or has expired" } });
    const box = await sendTo("me@x.com");
    fireEvent.change(box, { target: { value: LINK } });
    fireEvent.click(screen.getByText("Sign in with link"));
    expect(await screen.findByText(/opening the link uses it up/)).toBeTruthy();
  });
  it("an email already in hand: paste its link without sending a new one", async () => {
    const calls = setup();
    fireEvent.click(await screen.findByText("Already have a sign-in email? Paste its link"));
    fireEvent.change(screen.getByLabelText("Sign-in link"), { target: { value: LINK } });
    fireEvent.click(screen.getByText("Sign in with link"));
    await flush();
    expect(calls.otp.length).toBe(0);
    expect(calls.verify[0].token_hash).toBe("abc123hash");
  });
  it("offers no one-time-code box (sign-in is by link only)", async () => {
    setup();
    await sendTo("me@x.com");
    expect(screen.queryByLabelText("Sign-in code")).toBeNull();
    expect(screen.queryByText("Sign in with code")).toBeNull();
  });
});

describe("AuthGate hands its one /api/me answer to the app", () => {
  it("passes the answer to function children, with a single /api/me call", async () => {
    const me = { authorized: true, isAdmin: true, anthropicKey: { configured: true, valid: true, last4: "abcd" }, marketcheckKeys: [{ id: 1, label: "main", last4: "wxyz" }] };
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => me }));
    supabaseMock = mkSupabase(async () => ({ data: { session: { access_token: "t", user: { id: "u1", email: "x@y.z" } } } }));
    let got = null;
    render(<AuthGate>{(m) => { got = m; return <div>APPBODY</div>; }}</AuthGate>);
    await screen.findByText("APPBODY");
    expect(got).toEqual(me);
    expect(global.fetch.mock.calls.filter((c) => String(c[0]) === "/api/me").length).toBe(1);
  });
  it("fails open with an empty answer when /api/me errors", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline"); });
    supabaseMock = mkSupabase(async () => ({ data: { session: { access_token: "t", user: { id: "u1", email: "x@y.z" } } } }));
    let got = null;
    render(<AuthGate>{(m) => { got = m; return <div>APPBODY</div>; }}</AuthGate>);
    await screen.findByText("APPBODY");
    expect(got).toEqual({});
  });
});
