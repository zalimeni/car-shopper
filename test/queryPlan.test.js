import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupProfiles, mergedProfile, matchesProfile, attributeRow, parseYears, mapPowertrain } from "../src/queryPlan.js";

const P = (id, params) => ({ id, name: id, params });
const rav4 = P("rav4", { make: "Toyota", model: "RAV4", years: "2021-2022", maxPrice: 30000, maxMiles: 60000, powertrain: "Hybrid" });
const crv = P("crv", { make: "Honda", model: "CR-V", years: "2020,2022", maxPrice: 28000, maxMiles: 80000, powertrain: "hev" });
const ev = P("ioniq", { make: "Hyundai", model: "Ioniq 5", years: "2023", maxPrice: 35000 });
const row = (make, model, year, price, miles) => ({ vin: make + model + year + price, price, miles, build: { make, model, year } });

describe("groupProfiles", () => {
  it("merges profiles whose powertrain filter matches (after normalising), keeps others apart", () => {
    const g = groupProfiles([rav4, ev, crv]);
    expect(g.map((x) => x.map((p) => p.id))).toEqual([["rav4", "crv"], ["ioniq"]]);
  });
});

describe("mergedProfile", () => {
  it("unions make/model/years and takes the widest limits", () => {
    const m = mergedProfile([rav4, crv]);
    expect(m.params).toEqual({ make: "Toyota,Honda", model: "RAV4,CR-V", years: "2020,2021,2022", maxPrice: 30000, maxMiles: 80000, powertrain: "Hybrid" });
  });
  it("drops a filter any profile leaves unset, so no profile's cars are excluded", () => {
    const loose = P("any-crv", { make: "Honda", model: "CR-V" }); // no years / limits
    const m = mergedProfile([rav4, loose]);
    expect(m.params.years).toBeUndefined();
    expect(m.params.maxPrice).toBeUndefined();
    expect(m.params.make).toBe("Toyota,Honda");
  });
  it("leaves a single profile untouched", () => {
    expect(mergedProfile([rav4])).toBe(rav4);
  });
  it("dedupes repeated make values case-insensitively", () => {
    const c = P("camry", { make: "toyota", model: "Camry" });
    expect(mergedProfile([rav4, c]).params.make).toBe("Toyota");
  });
});

describe("attribution back to profiles", () => {
  const g = [rav4, crv];
  it("assigns each row to the profile whose own filters it meets", () => {
    expect(attributeRow(row("Toyota", "RAV4", 2021, 25000, 40000), g).id).toBe("rav4");
    expect(attributeRow(row("Honda", "CR-V", 2022, 25000, 70000), g).id).toBe("crv");
  });
  it("drops rows that only satisfy the merged union (another profile's year / price / miles)", () => {
    expect(attributeRow(row("Toyota", "RAV4", 2020, 25000, 40000), g)).toBeNull(); // 2020 is a CR-V year, not RAV4's
    expect(attributeRow(row("Toyota", "RAV4", 2021, 29999, 70000), g)).toBeNull(); // CR-V's mileage limit, not RAV4's
    expect(attributeRow(row("Honda", "CR-V", 2022, 29000, 1000), g)).toBeNull();   // RAV4's price limit, not CR-V's
  });
  it("prefers an exact model match over a loose one", () => {
    const camry = P("camry", { make: "Toyota", model: "Camry" });
    const camryHy = P("camry-hy", { make: "Toyota", model: "Camry Hybrid" });
    expect(attributeRow(row("Toyota", "Camry Hybrid", 2022, 1, 1), [camry, camryHy]).id).toBe("camry-hy");
    expect(attributeRow(row("Toyota", "Camry", 2022, 1, 1), [camry, camryHy]).id).toBe("camry");
  });
  it("tolerates naming differences in punctuation and case", () => {
    expect(matchesProfile(row("HONDA", "CRV", 2022, 1, 1), crv)).toBe(true);
  });
  it("a lone profile keeps every row MarketCheck returned for it, as before merging", () => {
    expect(attributeRow(row("Toyota", "Something Else", 1999, 1, 1), [rav4]).id).toBe("rav4");
  });
});

describe("helpers moved here still behave", () => {
  it("parseYears / mapPowertrain", () => {
    expect(parseYears("2016, 2018-2019")).toBe("2016,2018,2019");
    expect(mapPowertrain("Plug-in Hybrid")).toBe("PHEV");
  });
});

// ── through the real searchListings, with fetch mocked ──
process.env.MARKETCHECK_THROTTLE_MS = "1";
const { searchListings } = await import("../api/marketcheck.js");
let calls;
function mockFetch(fn) {
  calls = [];
  global.fetch = vi.fn(async (url) => {
    const u = new URL(url); calls.push(Object.fromEntries(u.searchParams));
    const { num_found, listings } = fn(Object.fromEntries(u.searchParams));
    const text = JSON.stringify({ num_found, listings });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
  });
}
const HUB = [{ n: "Durham, NC", z: "27701", lat: 36, lon: -78.9 }];

describe("searchListings with merged queries", () => {
  it("covers two compatible profiles with ONE request per location, and attributes the results", async () => {
    mockFetch(() => ({ num_found: 2, listings: [row("Toyota", "RAV4", 2021, 25000, 40000), row("Honda", "CR-V", 2022, 25000, 70000)] }));
    const r = await searchListings("K", [rav4, crv], HUB, {});
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ car_type: "used", make: "Toyota,Honda", model: "RAV4,CR-V", year: "2020,2021,2022", price_range: "0-30000", miles_range: "0-80000", powertrain_type: "HEV" });
    expect(calls[0].car_type).toBe("used");
    expect(r.listings.map((l) => l.profileId).sort()).toEqual(["crv", "rav4"]);
    expect(r.calls).toBe(1);
    expect(r.queries).toBe(1);
  });
  it("never sends a certified query (used already includes certified cars)", async () => {
    mockFetch(() => ({ num_found: 0, listings: [] }));
    await searchListings("K", [rav4, ev], HUB, {});
    expect(calls.every((c) => c.car_type === "used")).toBe(true);
    expect(calls.length).toBe(2); // two powertrain groups x one location
  });
  it("pages a merged group up to 200 rows per profile (here 400) instead of splitting", async () => {
    mockFetch((q) => ({ num_found: 256, listings: Array.from({ length: Math.min(50, 256 - Number(q.start)) }, (_, i) => row("Toyota", "RAV4", 2021, 20000 + Number(q.start) + i, 1000)) }));
    const r = await searchListings("K", [rav4, crv], HUB, {});
    expect(calls.map((c) => c.start)).toEqual(["0", "50", "100", "150", "200", "250"]);
    expect(r.splits).toBe(0);
  });
  it("splits a merged group that's too big to page, then runs each profile alone", async () => {
    mockFetch((q) => ({ num_found: q.make.indexOf(",") > -1 ? 900 : 10, listings: [] }));
    const r = await searchListings("K", [rav4, crv], HUB, {});
    expect(r.splits).toBe(1);
    expect(calls.map((c) => c.make)).toEqual(["Toyota,Honda", "Toyota", "Honda"]);
  });
  it("never pages past the account's 500-row pagination ceiling (MarketCheck 422s, and still charges)", async () => {
    const many = Array.from({ length: 5 }, (_, i) => P("p" + i, { make: "M" + i, model: "X" }));
    mockFetch((q) => ({ num_found: 480, listings: Array.from({ length: 50 }, (_, i) => row("M0", "X", 2020, i + Number(q.start), 1)) }));
    await searchListings("K", many, HUB, {});
    expect(Math.max(...calls.map((c) => Number(c.start) + Number(c.rows)))).toBeLessThanOrEqual(500);
  });
});
