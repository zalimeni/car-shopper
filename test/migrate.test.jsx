// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: {} }) } } }));
vi.mock("../src/storage", () => ({ default: { get: async () => null, set: async () => {} } }));
vi.mock("../src/Auth", () => ({ signOut: () => {} }));
const { migrate } = await import("../src/App.jsx");

describe("v8 migration: searches went nationwide", () => {
  it("drops the search-location list, making its first located entry the home base", () => {
    const d = migrate({ version: 7, settings: { hubs: [{ n: "Boston MA", z: "02101" }, { n: "Durham NC", z: "27701", lat: 35.99, lon: -78.9 }], mcSearches: { q1: { fp: "x" } } } });
    expect(d.settings.hubs).toBeUndefined();
    expect(d.settings.mcSearches).toBeUndefined();
    expect(d.settings.homeBase).toMatchObject({ z: "27701", lat: 35.99 });
    expect(d.settings.saltMode).toBe("exclude");
    expect(d.version).toBe(8);
  });
  it("keeps a chosen home base, borrowing coordinates from its matching location", () => {
    const d = migrate({ version: 7, settings: { homeBase: { n: "Durham NC", z: "27701" }, hubs: [{ n: "Boston MA", z: "02101", lat: 42.36, lon: -71.06 }, { n: "Durham NC", z: "27701", lat: 35.99, lon: -78.9 }] } });
    expect(d.settings.homeBase).toMatchObject({ z: "27701", lat: 35.99, lon: -78.9 });
  });
  it("leaves the home base empty when no location had coordinates", () => {
    expect(migrate({ version: 7, settings: { homeBase: null, hubs: [{ z: "02101" }] } }).settings.homeBase).toBeNull();
  });
});
