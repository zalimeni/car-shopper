import { describe, it, expect, vi } from "vitest";

process.env.MARKETCHECK_THROTTLE_MS = "1";
const { createSession, runStep, buildUrl, buildVinUrl } = await import("../api/marketcheck.js");
const { SALT_STATES, searchStates } = await import("../src/regions.js");

let calls;
function mockFetch(fn) {
  calls = [];
  global.fetch = vi.fn(async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams); calls.push(q);
    const text = JSON.stringify(fn(q));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
  });
}
const tucson = { id: "tucson", name: "Tucson Hybrid", params: { make: "Hyundai", model: "Tucson", powertrain: "Hybrid", years: "2022-2024", maxPrice: 27000 } };
const car = (vin, over) => Object.assign({ vin, price: 25000, miles: 1000, dos_active: 5, build: { make: "Hyundai", model: "Tucson", year: 2023 }, dealer: { state: "NC", latitude: "36", longitude: "-78.9" } }, over || {});
const page = (n, from, len) => Array.from({ length: len }, (_, i) => car("V" + (from + i)));
const step = (s) => runStep(createSession(["K"]), s);

describe("full refresh", () => {
  it("is one nationwide search with the salt belt left out via state=", async () => {
    mockFetch(() => ({ num_found: 2, listings: [car("A"), car("B")] }));
    const r = await step({ kind: "full", profile: tucson });
    expect(calls.length).toBe(1);
    expect(calls[0].latitude || calls[0].zip || calls[0].radius).toBeUndefined();
    const states = calls[0].state.split(",");
    expect(SALT_STATES.some((s) => states.includes(s))).toBe(false);
    expect(states).toContain("NC");
    expect(calls[0].powertrain_type).toBe("HEV");
    expect(r.numFound).toBe(2);
    expect(r.listings.map((l) => l.profileId)).toEqual(["tucson", "tucson"]);
  });
  it("in flag mode it searches every state", async () => {
    mockFetch(() => ({ num_found: 0, listings: [] }));
    await step({ kind: "full", profile: tucson, excludeSalt: false });
    expect(calls[0].state.split(",")).toEqual(searchStates(false));
  });
  it("pages every matching car", async () => {
    mockFetch((q) => ({ num_found: 120, listings: page(120, Number(q.start), Math.min(50, 120 - Number(q.start))) }));
    const r = await step({ kind: "full", profile: tucson });
    expect(calls.map((c) => c.start)).toEqual(["0", "50", "100"]);
    expect(r.listings.length).toBe(120);
  });
  it("over the 500-row ceiling it halves the state list until each part fits", async () => {
    // 900 cars overall; any list of 18 states or fewer has 300.
    mockFetch((q) => {
      const n = q.state.split(",").length > 18 ? 900 : 300;
      const start = Number(q.start);
      return { num_found: n, listings: page(n, start + q.state.length * 1000, Math.min(50, n - start)) };
    });
    const r = await step({ kind: "full", profile: tucson });
    const firsts = calls.filter((c) => c.start === "0").map((c) => c.state.split(",").length);
    expect(firsts[0]).toBe(searchStates(true).length);
    expect(firsts.slice(1).every((n) => n <= 18)).toBe(true);
    expect(calls.every((c) => Number(c.start) < 500)).toBe(true);
    expect(r.numFound).toBe(900);
    expect(r.errors).toEqual([]);
  });
  it("a single state still over the ceiling reads the newest 500 and says so", async () => {
    mockFetch((q) => ({ num_found: 800, listings: page(800, Number(q.start), 50) }));
    const r = await step({ kind: "full", profile: tucson, excludeSalt: false });
    expect(calls.every((c) => Number(c.start) < 500)).toBe(true);
    expect(r.notices.join(" ")).toMatch(/only the newest 500 were read/);
  });
});

describe("new-listings pass", () => {
  it("sorts newest-at-this-dealer first and stops once a page reaches past `since` days", async () => {
    mockFetch((q) => ({ num_found: 400, listings: page(400, Number(q.start), 50).map((c, i) => Object.assign(c, { dos_active: Number(q.start) / 25 + i / 50 })) }));
    await step({ kind: "new", profile: tucson, since: 2 });
    expect(calls[0]).toMatchObject({ sort_by: "dos_active", sort_order: "asc" });
    // page 1 ends under 1 day, page 2 at ~3 > 2: stop there
    expect(calls.map((c) => c.start)).toEqual(["0", "50"]);
  });
  it("one page when everything new fits on it", async () => {
    mockFetch(() => ({ num_found: 40, listings: page(40, 0, 40) }));
    const r = await step({ kind: "new", profile: tucson, since: 2 });
    expect(calls.length).toBe(1);
    expect(r.numFound).toBe(40);
  });
});

describe("count and VIN lookup", () => {
  it("count is one rows=0 call", async () => {
    mockFetch(() => ({ num_found: 597, listings: [] }));
    const r = await step({ kind: "count", profile: tucson });
    expect(calls.length).toBe(1);
    expect(calls[0].rows).toBe("0");
    expect(r.numFound).toBe(597);
  });
  it("looks up a list of VINs in one call (vin= takes a list), keeping the stored profile", async () => {
    mockFetch(() => ({ num_found: 2, listings: [car("W1"), car("W2")] }));
    const r = await step({ kind: "vins", vins: ["w1", "W2", "W3"] });
    expect(calls.length).toBe(1);
    expect(calls[0].vin).toBe("W1,W2,W3");
    expect(r.listings.map((l) => l.vin)).toEqual(["W1", "W2"]);
    expect(r.listings[0].profileId).toBeNull(); // reconcile keeps the listing's own profile
  });
  it("caps a lookup at 50 VINs", async () => {
    mockFetch(() => ({ num_found: 0, listings: [] }));
    await step({ kind: "vins", vins: Array.from({ length: 60 }, (_, i) => "V" + i) });
    expect(calls[0].vin.split(",").length).toBe(50);
  });
  it("buildVinUrl pages", () => {
    expect(new URL(buildVinUrl("K", "A,B", 50)).searchParams.get("start")).toBe("50");
  });
});

describe("local search (Price Check's live comps)", () => {
  it("is a radius search around the hub", async () => {
    mockFetch(() => ({ num_found: 1, listings: [car("L")] }));
    await step({ kind: "local", profile: tucson, hub: { lat: 36, lon: -78.9, r: 100 } });
    expect(calls[0]).toMatchObject({ latitude: "36", longitude: "-78.9", radius: "100" });
    expect(calls[0].state).toBeUndefined();
  });
  it("buildUrl extras override defaults", () => {
    const q = new URL(buildUrl("K", tucson, { national: true }, 0, "used", null, { sort_by: "dos_active", rows: "0" })).searchParams;
    expect([q.get("sort_by"), q.get("rows"), q.get("latitude")]).toEqual(["dos_active", "0", null]);
  });
});

describe("count step returns the color breakdown", () => {
  it("reads the base_exterior_color facet and how many cars list no color", async () => {
    mockFetch(() => ({ num_found: 1001, listings: [], facets: { base_exterior_color: [{ item: "Black", count: 261 }, { item: "Gray", count: 204 }, { item: "White", count: 186 }, { item: "Silver", count: 168 }, { item: "Blue", count: 148 }] } }));
    const r = await step({ kind: "count", profile: tucson });
    expect(calls[0].facets).toBe("base_exterior_color,version,drivetrain,year");
    expect(calls[0].stats).toBe("price,miles");
    expect(r.numFound).toBe(1001);
    expect(r.colors).toEqual({ counts: { Black: 261, Gray: 204, White: 186, Silver: 168, Blue: 148 }, unlisted: 34 });
  });
  it("reads the trim (version) and drivetrain facets from the same call", async () => {
    mockFetch(() => ({ num_found: 3916, listings: [], facets: {
      version: [{ item: "Limited", count: 1125 }, { item: "Touring XT", count: 356 }, { item: "-", count: 113 }],
      drivetrain: [{ item: "4WD", count: 3916 }] } }));
    const r = await step({ kind: "count", profile: tucson });
    expect(calls.length).toBe(1);
    expect(r.trims.counts).toEqual({ Limited: 1125, "Touring XT": 356, "-": 113 });
    expect(r.drivetrains).toEqual({ counts: { "4WD": 3916 }, unlisted: 0 });
  });
  it("returns the year facet and trimmed price/miles stats (the profile wizard)", async () => {
    mockFetch(() => ({ num_found: 1001, listings: [], facets: { year: [{ item: "2023", count: 600 }, { item: "2022", count: 401 }] },
      stats: { price: { min: 11799, max: 41497, median: 28178, sum: 1, sum_of_squares: 2, percentiles: { "25.0": 25514, "50.0": 28178 } }, miles: { min: 12, max: 175137 } } }));
    const r = await step({ kind: "count", profile: tucson });
    expect(r.years.counts).toEqual({ 2023: 600, 2022: 401 });
    expect(r.stats.price).toEqual({ min: 11799, max: 41497, mean: null, median: 28178, count: null, missing: null, percentiles: { "25.0": 25514, "50.0": 28178 } });
    expect(r.stats.miles.max).toBe(175137);
  });
  it("normalize: version as the trim ('-' falls back to the plain trim), drivetrain kept", async () => {
    mockFetch(() => ({ num_found: 2, listings: [car("A", { build: { make: "Subaru", model: "Outback", year: 2021, trim: "Base", version: "-", drivetrain: "4WD" } }),
      car("B", { build: { make: "Subaru", model: "Outback", year: 2021, trim: "Limited", version: "Limited XT", drivetrain: "4WD" } })] }));
    const r = await step({ kind: "full", profile: tucson });
    expect(r.listings.map((l) => [l.trim, l.drivetrain])).toEqual([["Base", "4WD"], ["Limited XT", "4WD"]]);
  });
  it("normalize keeps MarketCheck's base color", async () => {
    mockFetch(() => ({ num_found: 1, listings: [car("C", { exterior_color: "Phantom Black Pearl", base_ext_color: "Black" })] }));
    const r = await step({ kind: "full", profile: tucson });
    expect(r.listings[0]).toMatchObject({ color: "Phantom Black Pearl", baseColor: "Black" });
  });
});

describe("full refresh keeps the color list current", () => {
  it("asks for the color facet on the top-level page 1 only, and returns it", async () => {
    mockFetch((q) => ({ num_found: 120, listings: page(120, Number(q.start), Math.min(50, 120 - Number(q.start))),
      facets: q.facets ? { base_exterior_color: [{ item: "Gray", count: 70 }, { item: "Blue", count: 45 }] } : undefined }));
    const r = await step({ kind: "full", profile: tucson });
    expect(calls.map((c) => c.facets || null)).toEqual(["base_exterior_color,version,drivetrain", null, null]);
    expect(r.colors).toEqual({ counts: { Gray: 70, Blue: 45 }, unlisted: 5 });
  });
  it("split searches don't re-ask for it", async () => {
    mockFetch((q) => { const n = q.state.split(",").length > 18 ? 900 : 300; return { num_found: n, listings: [] }; });
    await step({ kind: "full", profile: tucson });
    expect(calls.filter((c) => c.facets).length).toBe(1);
  });
});

describe("decode step (NeoVIN)", () => {
  it("decodes each VIN once, keeping the base color when confident enough", async () => {
    const { decodedColor } = await import("../api/marketcheck.js");
    calls = [];
    global.fetch = vi.fn(async (url) => {
      calls.push(url);
      const vin = url.split("/neovin/")[1].split("/")[0];
      const body = vin.endsWith("1") ? { exterior_color: { name: "Shimmering Silver Metallic", base: "Silver", confidence: "0.8" } }
        : vin.endsWith("2") ? { exterior_color: { name: "Mystery", base: "Gray", confidence: "0.2" } } : {};
      const text = JSON.stringify(body);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone: () => ({ text: async () => text }) };
    });
    const r = await step({ kind: "decode", vins: ["KM8JCCD10RU1987A1", "KM8JCCD10RU1987A2", "KM8JCCD10RU1987A3", "not-a-vin"] });
    expect(calls.length).toBe(3);
    expect(calls[0]).toMatch(/\/v2\/decode\/car\/neovin\/KM8JCCD10RU1987A1\/specs\?api_key=K/);
    expect(r.decoded).toEqual({ KM8JCCD10RU1987A1: { color: "Shimmering Silver Metallic", baseColor: "Silver", confidence: 0.8 }, KM8JCCD10RU1987A2: null, KM8JCCD10RU1987A3: null });
    expect(r.errors).toEqual([]);
    expect(r.formatSuspect).toBe(false);
    expect(decodedColor(null)).toBeNull();
  });
  it("a VIN NeoVIN can't decode is remembered as 'no color', not a sync error", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "not found", json: async () => ({}), clone: () => ({ text: async () => "not found" }) }));
    const r = await step({ kind: "decode", vins: ["KM8JCCD10RU1987A1"] });
    expect(r.decoded).toEqual({ KM8JCCD10RU1987A1: null });
    expect(r.errors).toEqual([]);
  });
});
