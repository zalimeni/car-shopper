// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Settings → Two-factor (MfaCard) over a mocked supabase.auth.mfa, and the
// Admin tab's two-factor gate + lockout reset.

const mfa = vi.hoisted(() => ({ factors: [], calls: [] }));
vi.mock("../src/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: {} }),
      mfa: {
        listFactors: async () => ({ data: { all: mfa.factors.slice(), totp: mfa.factors.filter((f) => f.status === "verified") }, error: null }),
        enroll: async (a) => {
          mfa.calls.push(["enroll", a]);
          mfa.factors.push({ id: "new-1", factor_type: "totp", status: "unverified", friendly_name: a.friendlyName });
          return { data: { id: "new-1", type: "totp", totp: { qr_code: "data:image/svg+xml;utf-8,<svg></svg>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/Car%20Shopper:me?secret=JBSWY3DPEHPK3PXP" } }, error: null };
        },
        challengeAndVerify: async (a) => {
          mfa.calls.push(["verify", a]);
          if (a.code !== "123456") return { data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered" } };
          mfa.factors = mfa.factors.map((f) => f.id === a.factorId ? Object.assign({}, f, { status: "verified", created_at: "2026-11-18T00:00:00Z" }) : f);
          return { data: {}, error: null };
        },
        unenroll: async (a) => { mfa.calls.push(["unenroll", a]); mfa.factors = mfa.factors.filter((f) => f.id !== a.factorId); return { data: {}, error: null }; },
      },
    },
  },
}));
vi.mock("../src/storage", () => ({ watchState: async () => () => {}, default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), postStep: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
const adminApi = vi.hoisted(() => ({ list: null, reset: null }));
vi.mock("../src/admin", () => ({
  getMe: async () => ({}), listAllowed: () => adminApi.list(), addAllowed: async () => {}, removeAllowed: async () => {}, setAllowedFlags: async () => {},
  resetAllowedMfa: (e) => adminApi.reset(e),
}));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));

const { MfaCard, AdminTab } = await import("../src/App.jsx");

beforeEach(() => { cleanup(); mfa.factors = []; mfa.calls = []; vi.restoreAllMocks(); });

describe("Settings: two-factor enroll", () => {
  it("off → set up → QR + key + same-phone link → verify the first code → on, nudged to add a backup", async () => {
    render(<MfaCard isAdmin={true} />);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByText(/Admins must turn this on/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Authenticator name"), { target: { value: "iPhone" } });
    fireEvent.click(screen.getByText("Set up an authenticator app"));

    const img = await screen.findByAltText("QR code for your authenticator app");
    expect(img.getAttribute("src")).toBe("data:image/svg+xml;charset=utf-8," + encodeURIComponent("<svg></svg>"));
    expect(mfa.calls[0]).toEqual(["enroll", { factorType: "totp", friendlyName: "iPhone", issuer: "Tirekicker" }]);
    expect(screen.getByLabelText("Setup key").textContent).toBe("JBSW Y3DP EHPK 3PXP");
    expect(screen.getByText("Open in authenticator app").getAttribute("href")).toMatch(/^otpauth:\/\/totp\//);

    const box = screen.getByLabelText("Code from the app");
    expect(box.getAttribute("autocomplete")).toBe("one-time-code");
    expect(box.getAttribute("inputmode")).toBe("numeric");
    expect(box.style.fontSize).toBe("16px");

    fireEvent.change(box, { target: { value: "000000" } });
    fireEvent.click(screen.getByText("Verify and turn on"));
    expect(await screen.findByText(/didn't match/)).toBeTruthy();

    fireEvent.change(box, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify and turn on"));
    expect(await screen.findByText("On · 1 app")).toBeTruthy();
    expect(screen.getByText(/Two-factor is on/)).toBeTruthy();
    expect(screen.getByText(/Add a second app as a backup/)).toBeTruthy();
    expect(screen.getByText("Add a backup app")).toBeTruthy();
    expect(screen.getByText("iPhone")).toBeTruthy();
  });

  it("an unfinished enrollment is cleaned up before the next one; cancel unenrolls it", async () => {
    mfa.factors = [{ id: "stale", factor_type: "totp", status: "unverified", friendly_name: "Authenticator 1" }];
    render(<MfaCard isAdmin={false} />);
    fireEvent.click(await screen.findByText("Set up an authenticator app"));
    await screen.findByAltText("QR code for your authenticator app");
    expect(mfa.calls[0]).toEqual(["unenroll", { factorId: "stale" }]);
    expect(mfa.calls[1][1].friendlyName).toBe("Authenticator 1");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(mfa.calls.at(-1)).toEqual(["unenroll", { factorId: "new-1" }]));
    expect(screen.queryByAltText("QR code for your authenticator app")).toBeNull();
  });

  it("remove asks first, then unenrolls", async () => {
    mfa.factors = [{ id: "f1", factor_type: "totp", status: "verified", friendly_name: "iPhone", created_at: "2026-11-01T00:00:00Z" }];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MfaCard isAdmin={false} />);
    expect(await screen.findByText("On · 1 app")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove"));
    expect(window.confirm.mock.calls[0][0]).toMatch(/only one/);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(mfa.calls).toEqual([["unenroll", { factorId: "f1" }]]);
  });
});

describe("Admin tab: two-factor gate and lockout reset", () => {
  it("an admin without two-factor sees the setup prompt, not the table", async () => {
    adminApi.list = async () => { const e = new Error("Set up two-factor authentication in Settings to use the Admin tab"); e.code = "mfa_enroll_required"; throw e; };
    const goSettings = vi.fn();
    render(<AdminTab goSettings={goSettings} />);
    expect(await screen.findByText(/Set up two-factor authentication in Settings to use the Admin tab/)).toBeTruthy();
    expect(screen.queryByText(/Allowed emails/)).toBeNull();
    fireEvent.click(screen.getByText("Set up two-factor"));
    expect(goSettings).toHaveBeenCalled();
  });

  it("2FA · reset removes another account's apps", async () => {
    adminApi.list = async () => [{ email: "friend@x.com", mfa: 1 }, { email: "other@x.com", mfa: 0 }];
    adminApi.reset = vi.fn(async () => ({ ok: true, removed: 1 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminTab goSettings={() => {}} />);
    await screen.findByText("friend@x.com");
    const btns = screen.getAllByRole("button", { name: "2FA · reset" });
    expect(btns.length).toBe(1); // only the account that has two-factor on
    fireEvent.click(btns[0]);
    await waitFor(() => expect(adminApi.reset).toHaveBeenCalledWith("friend@x.com"));
    expect(await screen.findByText(/Two-factor reset for friend@x.com/)).toBeTruthy();
  });
});
