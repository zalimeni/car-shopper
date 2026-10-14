import { describe, it, expect, vi } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1";
const { searchListings, buildUrl, searchKey, nearestHubMi, pageFingerprint } = await import("../api/marketcheck.js");

let calls;
function mockFetch(fn) {
  calls = [];
  global.fetch = vi.fn(async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams); calls.push(q);
    const text = JSON.stringify(fn(q));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
  });
}
const P = (id, params) => ({ id, name: id, params });
const rav4 = P("rav4", { make: "Toyota", model: "RAV4", years: "2021", powertrain: "Hybrid" });
const prime = P("prime", { make: "Toyota", model: "RAV4", years: "2021", powertrain: "PHEV" });
const DURHAM = { n: "Durham NC", z: "27701", lat: 35.994, lon: -78.8986 };
const BOSTON = { n: "Boston MA", z: "02108", lat: 42.3581, lon: -71.0636 };
const car = (vin, lat, lon, pt) => ({ vin, price: 25000, miles: 1000, build: { make: "Toyota", model: "RAV4", year: 2021, powertrain_type: pt || "HEV" }, dealer: { latitude: String(lat), longitude: String(lon) } });

describe("nationwide search", () => {
  it("buildUrl sends no location for a national hub", () => {
    const q = new URL(buildUrl("K", rav4, { national: true })).searchParams;
    expect(q.has("latitude") || q.has("zip") || q.has("radius")).toBe(false);
  });
  it("its search key depends on which locations it's kept to", () => {
    expect(searchKey(rav4, { national: true, sig: "a" }, "used")).not.toBe(searchKey(rav4, { national: true, sig: "b" }, "used"));
  });
  it("nearestHubMi keeps only dealers inside a location's radius", () => {
    expect(nearestHubMi(35.9, -78.9, [DURHAM, BOSTON])).toBe(6);
    expect(nearestHubMi(33.4, -112, [DURHAM, BOSTON])).toBeNull(); // Phoenix
    expect(nearestHubMi(null, null, [DURHAM])).toBeNull();
  });
  it("one paged nationwide query covers every profile and location, filtered to your radii", async () => {
    const rows = [car("NEAR_DURHAM", 35.9, -78.9), car("NEAR_BOSTON", 42.4, -71.1, "PHEV"), car("PHOENIX", 33.4, -112)];
    mockFetch(() => ({ num_found: 3, listings: rows }));
    const r = await searchListings("K", [rav4, prime], [DURHAM, BOSTON], { national: "only" });
    expect(calls.length).toBe(1);
    expect(calls[0].powertrain_type).toBe("HEV,PHEV");
    expect(calls[0].latitude).toBeUndefined();
    const byVin = Object.fromEntries(r.listings.map((l) => [l.vin, l]));
    expect(Object.keys(byVin).sort()).toEqual(["NEAR_BOSTON", "NEAR_DURHAM"]);
    expect(byVin.NEAR_BOSTON.profileId).toBe("prime");
    expect(byVin.NEAR_DURHAM.distMi).toBe(6);
    expect(r.localProfiles).toEqual([]);
    expect(r.national).toBe(1);
  });
  it("pages the whole nationwide set (past the per-profile 200-row cap)", async () => {
    mockFetch((q) => ({ num_found: 260, listings: Array.from({ length: Math.min(50, 260 - Number(q.start)) }, (_, i) => car("V" + q.start + "_" + i, 36, -78.9)) }));
    const hubs = Array.from({ length: 6 }, (_, i) => Object.assign({}, DURHAM, { lat: 36 + i / 100, z: "x" + i }));
    const r = await searchListings("K", [rav4], hubs, { national: "only" });
    expect(calls.map((c) => c.start)).toEqual(["0", "50", "100", "150", "200", "250"]);
    expect(r.listings.length).toBe(260);
  });
  it("too many matches nationally: splits by profile, and leaves the still-too-big one to per-location search", async () => {
    mockFetch((q) => ({ num_found: q.powertrain_type === "PHEV" ? 20 : 900, listings: [car("X" + q.powertrain_type, 36, -78.9, q.powertrain_type)] }));
    const r = await searchListings("K", [rav4, prime], [DURHAM, BOSTON], { national: "only" });
    expect(calls.map((c) => c.powertrain_type)).toEqual(["HEV,PHEV", "HEV", "PHEV"]);
    expect(r.localProfiles).toEqual(["rav4"]);
  });
  it("costs no more than per-location: a nationwide set needing more pages than locations+1 is left to them", async () => {
    mockFetch(() => ({ num_found: 400, listings: [] })); // 8 pages vs 2 locations
    const r = await searchListings("K", [rav4], [DURHAM, BOSTON], { national: "only" });
    expect(calls.length).toBe(1);
    expect(r.localProfiles).toEqual(["rav4"]);
  });
  it("with national:true (cron) the leftover profiles run per location in the same call", async () => {
    mockFetch((q) => (q.latitude ? { num_found: 0, listings: [] } : { num_found: 900, listings: [] }));
    await searchListings("K", [rav4], [DURHAM, BOSTON], { national: true });
    expect(calls.map((c) => c.latitude || "nationwide")).toEqual(["nationwide", String(DURHAM.lat), String(BOSTON.lat)]);
  });
  it("skips nationwide when a location has no coordinates", async () => {
    mockFetch(() => ({ num_found: 0, listings: [] }));
    const r = await searchListings("K", [rav4], [DURHAM, { n: "zip only", z: "02101" }], { national: "only" });
    expect(calls.length).toBe(0);
    expect(r.localProfiles).toEqual(["rav4"]);
  });
  it("an unchanged nationwide page 1 stops the search and keeps its cars", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => car("U" + i, 36, -78.9));
    mockFetch((q) => ({ num_found: 120, listings: q.start === "0" ? rows : [] }));
    const first = await searchListings("K", [rav4], [DURHAM, BOSTON], { national: "only" });
    expect(calls.length).toBe(2); // page 2 comes back short, so it's done
    mockFetch(() => ({ num_found: 120, listings: rows }));
    const again = await searchListings("K", [rav4], [DURHAM, BOSTON], { national: "only", fingerprints: first.fingerprints });
    expect(calls.length).toBe(1);
    expect(again.unchanged.length).toBe(1);
    expect(again.listings[0].mcQ).toEqual(again.unchanged);
    expect(pageFingerprint(120, rows)).toBe(Object.values(first.fingerprints)[0]);
  });
  it("a failed nationwide call hands its profiles to per-location search, as a notice", async () => {
    calls = [];
    global.fetch = vi.fn(async (url) => { calls.push(url); return { ok: false, status: 500, headers: { get: () => null }, text: async () => "boom", json: async () => ({}), clone: () => ({ text: async () => "boom" }) }; });
    const r = await searchListings("K", [rav4], [DURHAM, BOSTON], { national: "only" });
    expect(r.localProfiles).toEqual(["rav4"]);
    expect(r.errors).toEqual([]);
    expect(r.notices[0]).toMatch(/nationwide.*HTTP 500.*searched per location instead/);
  });
  it("out of nationwide time: unfinished profiles go per location instead of the run stopping", async () => {
    process.env.MARKETCHECK_NATIONAL_BUDGET_MS = "1";
    vi.resetModules();
    const m = await import("../api/marketcheck.js");
    let n = 0;
    global.fetch = vi.fn(async (url) => {
      n++; await new Promise((r) => setTimeout(r, 5));
      const q = Object.fromEntries(new URL(url).searchParams);
      const text = JSON.stringify({ num_found: 900, listings: [car("T" + n, 36, -78.9, q.powertrain_type)] });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
    });
    const r = await m.searchListings("K", [rav4, prime], [DURHAM, BOSTON], { national: "only" });
    delete process.env.MARKETCHECK_NATIONAL_BUDGET_MS;
    expect(n).toBe(1); // the merged page, then out of time
    expect(r.localProfiles.sort()).toEqual(["prime", "rav4"]);
    expect(r.notices.join(" ")).toMatch(/Nationwide search ran out of time/);
    expect(r.errors).toEqual([]);
  });
});
