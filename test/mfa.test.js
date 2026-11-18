import { describe, it, expect, vi } from "vitest";

vi.mock("../src/supabaseClient", () => ({ supabase: {} }));
const { assurance, needsStepUp, isAal2, qrSrc, groupSecret, friendlyMfaError } = await import("../src/mfa.js");

function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b({ alg: "ES256" }) + "." + b(claims) + ".sig";
}
const verified = [{ id: "f1", factor_type: "totp", status: "verified" }];

describe("assurance (from the session, no network)", () => {
  it("no session: nothing to do", () => {
    expect(assurance(null)).toEqual({ currentLevel: null, nextLevel: null });
    expect(needsStepUp(null)).toBe(false);
  });
  it("email sign-in with an enrolled app: aal1 → aal2, step up", () => {
    const s = { access_token: jwt({ aal: "aal1" }), user: { factors: verified } };
    expect(assurance(s)).toEqual({ currentLevel: "aal1", nextLevel: "aal2" });
    expect(needsStepUp(s)).toBe(true);
  });
  it("after the code: aal2, no prompt", () => {
    const s = { access_token: jwt({ aal: "aal2" }), user: { factors: verified } };
    expect(needsStepUp(s)).toBe(false);
    expect(isAal2(s)).toBe(true);
  });
  it("no factor, or only an unfinished one: no prompt", () => {
    expect(needsStepUp({ access_token: jwt({ aal: "aal1" }), user: { factors: [] } })).toBe(false);
    expect(needsStepUp({ access_token: jwt({ aal: "aal1" }), user: { factors: [{ status: "unverified" }] } })).toBe(false);
    expect(needsStepUp({ user: {} })).toBe(false); // no token at all
  });
});

describe("helpers", () => {
  it("qrSrc encodes the raw SVG supabase-js hands back", () => {
    const src = qrSrc('data:image/svg+xml;utf-8,<svg fill="#000"></svg>');
    expect(src.indexOf("data:image/svg+xml;charset=utf-8,")).toBe(0);
    expect(src).not.toMatch(/#/);
    expect(decodeURIComponent(src.split(",")[1])).toBe('<svg fill="#000"></svg>');
  });
  it("groupSecret groups by four", () => {
    expect(groupSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
  it("friendlyMfaError explains a wrong code", () => {
    expect(friendlyMfaError({ code: "mfa_verification_failed", message: "Invalid TOTP code entered" })).toMatch(/didn't match/);
    expect(friendlyMfaError(new Error("boom"))).toBe("boom");
  });
});
