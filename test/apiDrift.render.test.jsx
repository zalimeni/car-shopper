// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
vi.mock("../src/sync", () => ({ fetchListings: async () => ({}), fetchPriceComps: async () => ({}), fetchRawSample: async () => ({}), reconcile: () => ({}) }));
vi.mock("../src/score", () => ({ getKeyStatus: async () => ({}), saveKey: async () => ({}), removeKey: async () => ({}), scoreSet: async () => [], getScorePrompt: async () => ({}), generateBaseline: async () => ({}), generatePriceAssessment: async () => "", SCORE_MODEL_OPTIONS: [], DEFAULT_SCORE_MODEL: "x" }));
vi.mock("../src/admin", () => ({ getMe: async () => ({}), listAllowed: async () => [], addAllowed: async () => {}, removeAllowed: async () => {} }));
vi.mock("../src/snapshots", () => ({ listSnapshots: async () => [], restoreSnapshot: async () => {} }));
const { apiDriftNotice } = await import("../src/App.jsx");

const api = { served: "v4.8.0", pinned: "v4.8.0", deprecation: "Fri, 07 Aug 2026 00:00:00 GMT", sunset: "Sun, 28 Feb 2027 23:59:59 GMT", pinRejected: false };
const day = (iso) => Date.parse(iso);

describe("apiDriftNotice", () => {
  it("is quiet while the sunset is more than 60 days out (deprecated alone isn't actionable)", () => {
    expect(apiDriftNotice(api, day("2026-10-14T12:00:00Z"))).toBeNull();
    expect(apiDriftNotice(null)).toBeNull();
  });
  it("warns inside 60 days with a countdown, and after sunset", () => {
    expect(apiDriftNotice(api, day("2027-01-15T00:00:00Z"))).toMatch(/v4\.8\.0 sunsets .*2027.* \(45 days\)/);
    expect(apiDriftNotice(api, day("2027-03-02T00:00:00Z"))).toMatch(/reached its sunset/);
  });
  it("warns at once if MarketCheck answers with a different major version than we pinned", () => {
    expect(apiDriftNotice(Object.assign({}, api, { served: "v5.0.1", sunset: null }), day("2026-10-14T00:00:00Z"))).toMatch(/answered with API v5\.0\.1, not the v4\.8\.0/);
  });
  it("a newer minor of the same major is fine", () => {
    expect(apiDriftNotice(Object.assign({}, api, { served: "v4.9.2", sunset: null }), day("2026-10-14T00:00:00Z"))).toBeNull();
  });
  it("warns if the pin itself was rejected", () => {
    expect(apiDriftNotice(Object.assign({}, api, { pinRejected: true }), day("2026-10-14T00:00:00Z"))).toMatch(/rejected the pinned API version \(v4\.8\.0\)/);
  });
});
