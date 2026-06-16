import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildUrl, parseYears, normalize, mapDealerType } from "../api/marketcheck.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/marketcheck-active-search.json", import.meta.url)), "utf8")
);

// Golden test on the request we send. This guards the exact bugs that broke the
// live sync: wrong host, year as a comma list instead of year_range, and an
// invalid seller_type param.
describe("buildUrl", () => {
  const profile = {
    id: "rav4-hybrid",
    params: { make: "Toyota", model: "RAV4 Hybrid", years: "2019-2022", maxPrice: 25000, maxMiles: 90000 },
  };
  const url = buildUrl("TEST_KEY", profile, { n: "Boston MA", z: "02101" });
  const qs = url.split("?")[1];
  const params = new URLSearchParams(qs);

  it("targets the correct host + endpoint", () => {
    expect(url.startsWith("https://api.marketcheck.com/v2/search/car/active?")).toBe(true);
  });
  it("maps profile params to MarketCheck params", () => {
    expect(params.get("api_key")).toBe("TEST_KEY");
    expect(params.get("car_type")).toBe("used");
    expect(params.get("make")).toBe("Toyota");
    expect(params.get("model")).toBe("RAV4 Hybrid");
    expect(params.get("year_range")).toBe("2019-2022");
    expect(params.get("price_range")).toBe("0-25000");
    expect(params.get("miles_range")).toBe("0-90000");
    expect(params.get("zip")).toBe("02101");
    expect(params.get("radius")).toBe("100");
    expect(params.get("rows")).toBe("50");
  });
  it("does not send the invalid seller_type param", () => {
    expect(params.has("seller_type")).toBe(false);
  });

  it("uses lat/long (not zip) when the hub has coordinates", () => {
    const u = buildUrl("K", profile, { n: "Boston MA", z: "02101", lat: 42.3601, lon: -71.0589 });
    const p = new URLSearchParams(u.split("?")[1]);
    expect(p.get("latitude")).toBe("42.3601");
    expect(p.get("longitude")).toBe("-71.0589");
    expect(p.has("zip")).toBe(false);
    expect(p.get("radius")).toBe("100");
  });
});

describe("parseYears", () => {
  it("expands a range", () => expect(parseYears("2019-2022")).toBe("2019,2020,2021,2022"));
  it("keeps a non-contiguous list", () => expect(parseYears("2016, 2018")).toBe("2016,2018"));
  it("handles a single year", () => expect(parseYears("2021")).toBe("2021"));
  it("handles empty", () => expect(parseYears("")).toBe(""));
});

// Golden test on response -> app listing. Update expectations if the fixture is
// replaced with a real captured response whose field names differ.
describe("normalize", () => {
  it("maps a dealer listing", () => {
    expect(normalize(fixture.listings[0], "rav4-hybrid")).toEqual({
      vin: "JTMRWRFV0KD012345",
      vehicle: "Toyota RAV4 Hybrid",
      year: 2021,
      trim: "XLE",
      price: 28998,
      mileage: 31250,
      dealer: "Example Toyota of Boston",
      dealerType: "franchise",
      location: "Boston",
      state: "MA",
      color: "Silver",
      link: "https://www.example-toyota-boston.com/used/Toyota/2021-RAV4-Hybrid-abc123.htm",
      dom: 21,
      profileId: "rav4-hybrid",
      source: "marketcheck",
    });
  });

  it("treats cpo as CPO regardless of dealer_type", () => {
    const n = normalize(fixture.listings[1], "bolt-euv");
    expect(n.dealerType).toBe("CPO");
    expect(n.vehicle).toBe("Chevrolet Bolt EUV");
    expect(n.mileage).toBe(28900);
  });
});

describe("mapDealerType", () => {
  it("CPO wins", () => expect(mapDealerType({ cpo: "True" }, { dealer_type: "independent" })).toBe("CPO"));
  it("independent", () => expect(mapDealerType({}, { dealer_type: "Independent" })).toBe("independent"));
  it("defaults to franchise", () => expect(mapDealerType({}, {})).toBe("franchise"));
});
