import { describe, it, expect } from "vitest";
import { parseSignInLink } from "../src/authLink.js";

// Shape of the link Supabase emails for signInWithOtp with the implicit flow.
const EMAILED = "https://dispkandrvmycwccavvl.supabase.co/auth/v1/verify?token=8c1f2e3d4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8&type=magiclink&redirect_to=https://car-shopper.vercel.app";

describe("parseSignInLink", () => {
  it("reads the token hash and type from the emailed link", () => {
    expect(parseSignInLink(EMAILED)).toEqual({ tokenHash: "8c1f2e3d4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8", type: "magiclink" });
  });
  it("tolerates surrounding whitespace and a first-time-user signup link", () => {
    expect(parseSignInLink("  " + EMAILED.replace("type=magiclink", "type=signup") + "\n").type).toBe("signup");
  });
  it("defaults an unknown or missing type to magiclink", () => {
    expect(parseSignInLink("https://x.supabase.co/auth/v1/verify?token=abc").type).toBe("magiclink");
    expect(parseSignInLink("https://x.supabase.co/auth/v1/verify?token=abc&type=weird").type).toBe("magiclink");
  });
  it("reads a session from the page Safari landed on after signing in", () => {
    expect(parseSignInLink("https://car-shopper.vercel.app/#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=magiclink"))
      .toEqual({ accessToken: "AT", refreshToken: "RT" });
  });
  it("flags a PKCE link, which only works in the browser that asked for it", () => {
    expect(parseSignInLink("https://x.supabase.co/auth/v1/verify?token=pkce_abc&type=magiclink")).toEqual({ error: "pkce" });
  });
  it("returns null for anything else", () => {
    expect(parseSignInLink("")).toBeNull();
    expect(parseSignInLink("123456")).toBeNull();
    expect(parseSignInLink("https://example.com/page")).toBeNull();
  });
});
