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
    expect(d.version).toBe(10);
  });
  it("keeps a chosen home base, borrowing coordinates from its matching location", () => {
    const d = migrate({ version: 7, settings: { homeBase: { n: "Durham NC", z: "27701" }, hubs: [{ n: "Boston MA", z: "02101", lat: 42.36, lon: -71.06 }, { n: "Durham NC", z: "27701", lat: 35.99, lon: -78.9 }] } });
    expect(d.settings.homeBase).toMatchObject({ z: "27701", lat: 35.99, lon: -78.9 });
  });
  it("leaves the home base empty when no location had coordinates", () => {
    expect(migrate({ version: 7, settings: { homeBase: null, hubs: [{ z: "02101" }] } }).settings.homeBase).toBeNull();
  });
});

describe("v9 migration: trim text filters are gone", () => {
  it("drops trimInclude/trimExclude, keeps the chips", () => {
    const d = migrate({ version: 8, settings: {}, profiles: [
      { id: "a", params: { make: "Subaru", trimExclude: "XT", trimInclude: "", excludeTrims: ["Limited XT"] } },
      { id: "b", params: { make: "Chevrolet" } }] });
    expect(d.profiles[0].params).toEqual({ make: "Subaru", excludeTrims: ["Limited XT"] });
    expect(d.profiles[1].params).toEqual({ make: "Chevrolet" });
  });
});

describe("v10 migration: frozen days-on-market notes are gone", () => {
  it("drops only those notes, from every list", () => {
    const d = migrate({ version: 9, settings: {},
      listings: [{ id: "a", notes: "9 days on market · ↓ Price $21,000 → $20,000 (2026-10-02)" }, { id: "b", notes: "1 day on market" }, { id: "c", notes: "30 days on market, priced high" }],
      candidates: [{ vin: "V1", notes: "12 days on market" }], skipped: [{ vin: "V2", notes: "call Tues · 4 days on market" }] });
    expect(d.listings.map((l) => l.notes)).toEqual(["↓ Price $21,000 → $20,000 (2026-10-02)", "", "30 days on market, priced high"]);
    expect(d.candidates[0].notes).toBe("");
    expect(d.skipped[0].notes).toBe("call Tues");
    expect(d.version).toBe(10);
  });
});
