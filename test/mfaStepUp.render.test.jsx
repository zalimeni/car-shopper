// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

// The two-factor step-up in AuthGate: after an email sign-in (here the pasted
// link, the path an iPhone Home Screen app uses) an account with an
// authenticator app gets a code prompt before the app loads.

function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b({ alg: "ES256" }) + "." + b(claims) + ".sig";
}
const FACTORS = [
  { id: "f-phone", factor_type: "totp", status: "verified", friendly_name: "iPhone" },
  { id: "f-backup", factor_type: "totp", status: "verified", friendly_name: "iPad" },
];
const user = (factors) => ({ id: "u1", email: "me@x.com", factors: factors });
const aal1 = (factors) => ({ access_token: jwt({ aal: "aal1" }), user: user(factors) });
const aal2 = () => ({ access_token: jwt({ aal: "aal2" }), user: user(FACTORS) });

let handlers = [];
let supabaseMock;
let verifyCalls = [];
let meStatus = 200;
function emit(event, s) { act(() => { handlers.forEach((h) => h(event, s)); }); }
function mk(initial, verifyImpl) {
  verifyCalls = [];
  return {
    auth: {
      getSession: async () => ({ data: { session: initial } }),
      onAuthStateChange: (cb) => { handlers.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOtp: async () => ({ error: null }),
      verifyOtp: async () => ({ error: null }),
      setSession: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
      mfa: {
        listFactors: async () => ({ data: { all: FACTORS, totp: FACTORS, phone: [] }, error: null }),
        challengeAndVerify: async (a) => { verifyCalls.push(a); return verifyImpl ? verifyImpl(a) : { data: {}, error: null }; },
      },
    },
  };
}
vi.mock("../src/supabaseClient", () => ({ get supabase() { return supabaseMock; } }));
const fetchMock = vi.fn(async (url, init) => {
  const tok = String((init && init.headers && init.headers.Authorization) || "");
  // The server's rule: an enrolled user's aal1 token gets mfa_required.
  if (meStatus === 401 && tok.indexOf(jwt({ aal: "aal2" })) < 0) return { ok: false, status: 401, json: async () => ({ authorized: false, code: "mfa_required", error: "Enter the code" }) };
  return { ok: true, status: 200, json: async () => ({ authorized: true }) };
});
global.fetch = fetchMock;
const meCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/me").length;

const AuthGate = (await import("../src/Auth.jsx")).default;

beforeEach(() => { handlers = []; meStatus = 200; fetchMock.mockClear(); cleanup(); });

describe("two-factor step-up at sign-in", () => {
  it("pasted link → aal1 session with an app → code prompt → aal2 → app", async () => {
    supabaseMock = mk(null);
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    fireEvent.click(await screen.findByText("Already have a sign-in email? Paste its link"));
    fireEvent.change(screen.getByLabelText("Sign-in link"), { target: { value: "https://p.supabase.co/auth/v1/verify?token=h&type=magiclink" } });
    fireEvent.click(screen.getByText("Sign in with link"));
    emit("SIGNED_IN", aal1(FACTORS));

    const box = await screen.findByLabelText("Two-factor code");
    expect(screen.queryByText("APPBODY")).toBeNull();
    expect(box.getAttribute("autocomplete")).toBe("one-time-code");
    expect(box.getAttribute("inputmode")).toBe("numeric");
    expect(meCalls()).toBe(0); // the app's access check waits for the code

    fireEvent.change(box, { target: { value: "123 456" } }); // a full code submits itself
    await waitFor(() => expect(verifyCalls.length).toBe(1));
    expect(verifyCalls[0]).toEqual({ factorId: "f-phone", code: "123456" });

    emit("MFA_CHALLENGE_VERIFIED", aal2());
    await screen.findByText("APPBODY");
    expect(meCalls()).toBe(1);
  });

  it("a code from the backup app works too (tries each app)", async () => {
    supabaseMock = mk(aal1(FACTORS), (a) => a.factorId === "f-backup" ? { data: {}, error: null } : { data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered" } });
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    const box = await screen.findByLabelText("Two-factor code");
    fireEvent.change(box, { target: { value: "654321" } });
    await waitFor(() => expect(verifyCalls.map((c) => c.factorId)).toEqual(["f-phone", "f-backup"]));
    expect(screen.queryByText(/didn't match/)).toBeNull();
  });

  it("a wrong code says so and clears the box", async () => {
    supabaseMock = mk(aal1(FACTORS), () => ({ data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered" } }));
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    fireEvent.change(await screen.findByLabelText("Two-factor code"), { target: { value: "000000" } });
    expect(await screen.findByText(/didn't match/)).toBeTruthy();
    expect(screen.getByLabelText("Two-factor code").value).toBe("");
    expect(screen.queryByText("APPBODY")).toBeNull();
  });

  it("no app on the account: straight in, no prompt", async () => {
    supabaseMock = mk(aal1([]));
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    await screen.findByText("APPBODY");
    expect(screen.queryByLabelText("Two-factor code")).toBeNull();
  });

  it("the server's mfa_required (app added on another device) also brings up the prompt", async () => {
    meStatus = 401;
    supabaseMock = mk(aal1([])); // this session's user record predates the enrollment
    render(<AuthGate><div>APPBODY</div></AuthGate>);
    const box = await screen.findByLabelText("Two-factor code");
    expect(screen.queryByText("APPBODY")).toBeNull();
    fireEvent.change(box, { target: { value: "123456" } });
    await waitFor(() => expect(verifyCalls.length).toBe(1));
    emit("MFA_CHALLENGE_VERIFIED", aal2());
    await screen.findByText("APPBODY");
  });
});
