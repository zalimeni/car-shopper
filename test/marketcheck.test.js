import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildUrl, parseYears, normalize, mapDealerType, isCpo, mapPowertrain, pickPhoto, safeHttpUrl } from "../api/marketcheck.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/marketcheck-active-search.json", import.meta.url)), "utf8")
);

// Golden test on the request we send. This guards the exact bugs that broke the
// live sync: wrong host, an invalid seller_type param, and year filtering (we
// send exact years as a CSV so non-contiguous profiles exclude gap years).
describe("buildUrl", () => {
  const profile = {
    id: "rav4-hybrid",
    params: { make: "Toyota", model: "RAV4", powertrain: "Hybrid", years: "2019-2022", maxPrice: 25000, maxMiles: 90000 },
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
    expect(params.get("model")).toBe("RAV4");
    expect(params.get("powertrain_type")).toBe("HEV"); // "Hybrid" -> MarketCheck code
    expect(params.get("year")).toBe("2019,2020,2021,2022");
    expect(params.has("year_range")).toBe(false);
    expect(params.get("price_range")).toBe("0-25000");
    expect(params.get("miles_range")).toBe("0-90000");
    expect(params.get("zip")).toBe("02101");
    expect(params.get("radius")).toBe("100");
    expect(params.get("rows")).toBe("50");
    expect(params.get("start")).toBe("0"); // default page
  });
  it("sets the paging offset from the start arg", () => {
    const u = buildUrl("K", { id: "x", params: { make: "Toyota", model: "RAV4" } }, { z: "02101" }, 100);
    expect(new URLSearchParams(u.split("?")[1]).get("start")).toBe("100");
  });
  it("defaults car_type to used and accepts a certified override", () => {
    const base = { id: "x", params: { make: "Toyota", model: "RAV4" } };
    expect(new URLSearchParams(buildUrl("K", base, { z: "02101" }).split("?")[1]).get("car_type")).toBe("used");
    expect(new URLSearchParams(buildUrl("K", base, { z: "02101" }, 0, "certified").split("?")[1]).get("car_type")).toBe("certified");
  });
  it("adds dealer_type only when provided", () => {
    const base = { id: "x", params: { make: "Toyota", model: "RAV4" } };
    expect(new URLSearchParams(buildUrl("K", base, { z: "02101" }).split("?")[1]).has("dealer_type")).toBe(false);
    expect(new URLSearchParams(buildUrl("K", base, { z: "02101" }, 0, "used", "franchise").split("?")[1]).get("dealer_type")).toBe("franchise");
  });
  it("sends exact years for a non-contiguous profile, excluding the gap year", () => {
    const u = buildUrl("K", { id: "volt", params: { make: "Chevrolet", model: "Volt", years: "2016, 2018" } }, { z: "02101" });
    const p = new URLSearchParams(u.split("?")[1]);
    expect(p.get("year")).toBe("2016,2018"); // not 2016-2018, which would include 2017
  });
  it("omits powertrain_type when the profile has none", () => {
    const u = buildUrl("K", { id: "x", params: { make: "Chevrolet", model: "Bolt EV", years: "2021-2023" } }, { z: "27701" });
    expect(new URLSearchParams(u.split("?")[1]).has("powertrain_type")).toBe(false);
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

describe("mapPowertrain", () => {
  it("maps friendly words to MarketCheck codes", () => {
    expect(mapPowertrain("Hybrid")).toBe("HEV");
    expect(mapPowertrain("hev")).toBe("HEV");
    expect(mapPowertrain("PHEV")).toBe("PHEV");
    expect(mapPowertrain("Plug-in Hybrid")).toBe("PHEV");
    expect(mapPowertrain("gas")).toBe("Combustion");
  });
});

describe("parseYears", () => {
  it("expands a range", () => expect(parseYears("2019-2022")).toBe("2019,2020,2021,2022"));
  it("keeps a non-contiguous list", () => expect(parseYears("2016, 2018")).toBe("2016,2018"));
  it("handles a single year", () => expect(parseYears("2021")).toBe("2021"));
  it("handles empty", () => expect(parseYears("")).toBe(""));
});

// Golden test on response -> app listing, against a REAL captured MarketCheck
// listing (see fixtures/). Verifies the live schema mapping.
describe("normalize", () => {
  it("maps a real franchise-dealer listing", () => {
    expect(normalize(fixture.listings[0], "rav4-hybrid")).toEqual({
      vin: "4T3LWRFV9MU040436",
      vehicle: "Toyota RAV4",
      year: 2021,
      trim: "Hybrid LE AWD",
      price: 23997,
      mileage: 84755,
      dealer: "Courtesy Mitsubishi",
      dealerType: "franchise",
      cpo: false,
      location: "Attleboro",
      state: "MA",
      color: "Midnight Black Metallic",
      link: "https://www.courtesymitsubishima.com/auto/used-2021-toyota-rav4-hybrid-le-attleboro-ma/121137914/",
      photo: "",
      dom: 18,
      distMi: 36, // MarketCheck `dist` 35.74, rounded
      carfax_1_owner: true,
      carfax_clean_title: false,
      price_change_percent: 0,
      msrp: 23997,
      profileId: "rav4-hybrid",
      source: "marketcheck",
    });
  });

  it("maps dealer_type independent", () => {
    const n = normalize(fixture.listings[1], "rav4-hybrid");
    expect(n.dealerType).toBe("independent");
    expect(n.mileage).toBe(80857);
    expect(n.state).toBe("ME");
    expect(n.distMi).toBe(81); // dist 81.26, rounded
  });

  it("leaves distMi null when the response has no dist", () => {
    expect(normalize({ vin: "X", build: {} }, "p").distMi).toBe(null);
  });

  it("drops a non-http(s) vdp_url instead of passing it to the client", () => {
    const n = normalize({ vin: "X", vdp_url: "javascript:alert(1)", build: {} }, "p");
    expect(n.link).toBe("");
    expect(normalize({ vin: "X", vdp_url: "https://dealer.example/car", build: {} }, "p").link).toBe("https://dealer.example/car");
  });

  it("falls back to trim when build.version is absent", () => {
    const n = normalize({ vin: "X", build: { make: "Chevrolet", model: "Bolt EUV", trim: "Premier" } }, "bolt-euv");
    expect(n.vehicle).toBe("Chevrolet Bolt EUV");
    expect(n.trim).toBe("Premier");
  });
});

describe("pickPhoto", () => {
  it("picks the first photo and caps the CDN width", () => {
    const row = { media: { photo_links: ["https://cdn.example.com/resrc/images/c_limit,fl_lossy,w_900/v1/x.jpg"] } };
    expect(pickPhoto(row)).toBe("https://cdn.example.com/resrc/images/c_limit,fl_lossy,w_400/v1/x.jpg");
  });
  it("rewrites w_auto", () => {
    expect(pickPhoto({ media: { photo_links: ["https://c/images/w_auto/v1/x.jpg"] } })).toBe("https://c/images/w_400/v1/x.jpg");
  });
  it("skips coming-soon placeholders", () => {
    const row = { media: { photo_links: ["https://x/photo-coming-soon/toyota.png", "https://cdn/images/c_limit,w_900/v1/real.jpg"] } };
    expect(pickPhoto(row)).toBe("https://cdn/images/c_limit,w_400/v1/real.jpg");
  });
  it("returns '' when there are no usable photos", () => {
    expect(pickPhoto({ media: { photo_links: [] } })).toBe("");
    expect(pickPhoto({})).toBe("");
  });
  it("never uses photo_links_cached (key-bearing)", () => {
    const row = { media: { photo_links_cached: ["https://api.marketcheck.com/v2/image/cache/x?api_key=mc_live_SECRET"] } };
    expect(pickPhoto(row)).toBe("");
  });
  it("skips non-http(s) entries (rendered as <a href>/<img src> in the client)", () => {
    const row = { media: { photo_links: ["javascript:alert(1)", "https://cdn/images/w_900/v1/real.jpg"] } };
    expect(pickPhoto(row)).toBe("https://cdn/images/w_400/v1/real.jpg");
  });
});

describe("safeHttpUrl", () => {
  it("allows http(s) only", () => {
    expect(safeHttpUrl("https://x.example/a")).toBe("https://x.example/a");
    expect(safeHttpUrl("http://x.example/a")).toBe("http://x.example/a");
    expect(safeHttpUrl("  https://x.example/a ")).toBe("https://x.example/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBe("");
    expect(safeHttpUrl("data:text/html,hi")).toBe("");
    expect(safeHttpUrl("//x.example/a")).toBe("");
    expect(safeHttpUrl(null)).toBe("");
    expect(safeHttpUrl(42)).toBe("");
  });
});

describe("mapDealerType", () => {
  // CPO is now decoupled — dealer type reflects the actual seller category even
  // for certified inventory (a CPO car is typically a franchise dealer).
  it("keeps the real type for a CPO listing", () => expect(mapDealerType({ cpo: "True" }, { dealer_type: "independent" })).toBe("independent"));
  it("independent", () => expect(mapDealerType({}, { dealer_type: "Independent" })).toBe("independent"));
  it("defaults to franchise", () => expect(mapDealerType({}, {})).toBe("franchise"));
});

describe("isCpo", () => {
  it("detects the MarketCheck is_certified flag (1 / '1' / true)", () => {
    expect(isCpo({ is_certified: 1 })).toBe(true);
    expect(isCpo({ is_certified: "1" })).toBe(true);
    expect(isCpo({ is_certified: true })).toBe(true);
  });
  it("is false when absent or not certified", () => {
    expect(isCpo({})).toBe(false);
    expect(isCpo({ is_certified: 0 })).toBe(false);
    expect(isCpo({ cpo: "True" })).toBe(false); // the old (wrong) field is ignored
  });
  it("normalize surfaces cpo from is_certified", () => {
    expect(normalize({ vin: "X", is_certified: 1, build: {} }, "p").cpo).toBe(true);
    expect(normalize({ vin: "Y", build: {} }, "p").cpo).toBe(false);
  });
});
