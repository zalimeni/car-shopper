import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseLocations, searchLocations, hubKey, hubParts, normalizeHubs, addHub, hubFromZip } from "../src/locations.js";

const TXT = [
  "KY|Louisville|40202|38.255|-85.755", "KY|Louisville|40203|38.240|-85.770", "KY|Louisville|40204|38.235|-85.710",
  "MA|Boston|02101|42.360|-71.059", "MA|Boston|02108|42.357|-71.064",
  "NC|Chapel Hill|27514|35.940|-79.040",
  "NC|Durham|27701|35.997|-78.897", "NC|Durham|27702|36.051|-78.858",
  "TX|Austin|78701|30.271|-97.743",
  "TX|Durham Springs|75001|32.0|-96.0",
].join("\n");
const idx = parseLocations(TXT);

describe("parseLocations", () => {
  it("indexes every ZIP and groups one entry per city", () => {
    expect(idx.rows.length).toBe(10);
    expect(idx.byZip["27701"].city).toBe("Durham");
    expect(idx.cities.filter((c) => c.city === "Louisville").length).toBe(1);
    expect(idx.cities.find((c) => c.city === "Louisville").zips).toBe(3);
  });
  it("skips malformed lines", () => {
    expect(parseLocations("junk\nNC|Durham|27701|x|y\nNC|Durham|27701|35|-78").rows.length).toBe(1);
  });
});

describe("searchLocations", () => {
  const labels = (q) => searchLocations(idx, q).map((r) => r.label);
  it("matches city prefixes case-insensitively", () => {
    expect(labels("dur")).toEqual(["Durham, NC", "Durham Springs, TX"]);
  });
  it("accepts 'city st' and 'city, st'", () => {
    expect(labels("durham nc")).toEqual(["Durham, NC"]);
    expect(labels("Durham, NC")).toEqual(["Durham, NC"]);
    expect(labels("durham tx")).toEqual(["Durham Springs, TX"]); // prefix match, scoped to the state
    expect(labels("durham ky")).toEqual([]);
  });
  it("matches a later word in the name, ranked after prefixes", () => {
    expect(labels("hill")).toEqual(["Chapel Hill, NC"]);
  });
  it("ranks exact before prefix, and bigger cities first within a rank", () => {
    expect(labels("boston")[0]).toBe("Boston, MA");
  });
  it("matches ZIPs by prefix", () => {
    expect(labels("277")).toEqual(["Durham, NC 27701", "Durham, NC 27702"]);
  });
  it("returns a ready-to-store hub with coordinates", () => {
    expect(searchLocations(idx, "austin")[0].hub).toEqual({ n: "Austin, TX", c: "Austin", st: "TX", z: "78701", lat: 30.271, lon: -97.743 });
  });
  it("is empty for blank input or no index", () => {
    expect(searchLocations(idx, "  ")).toEqual([]);
    expect(searchLocations(null, "dur")).toEqual([]);
  });
});

describe("hub dedupe + sort", () => {
  const D = { n: "Durham, NC", c: "Durham", st: "NC", z: "27701", lat: 35.997, lon: -78.897 };
  const B = { n: "Boston, MA", c: "Boston", st: "MA", z: "02101" };
  const L = { n: "Louisville, KY", c: "Louisville", st: "KY", z: "40202" };
  it("keys by ZIP, so different labels for one ZIP collapse", () => {
    expect(hubKey({ n: "Durham NC", z: "27701" })).toBe(hubKey(D));
    expect(hubKey({ n: " Raleigh  NC " })).toBe(hubKey({ n: "raleigh nc" }));
  });
  it("sorts by state, then city", () => {
    const out = normalizeHubs([D, B, L, { n: "Asheville, NC", c: "Asheville", st: "NC", z: "28801" }]);
    expect(out.map((h) => h.n)).toEqual(["Louisville, KY", "Boston, MA", "Asheville, NC", "Durham, NC"]);
  });
  it("dedupes and keeps coordinates from whichever duplicate has them", () => {
    const out = normalizeHubs([{ n: "Durham NC", z: "27701" }, D]);
    expect(out.length).toBe(1);
    expect(out[0].lat).toBe(35.997);
  });
  it("parses legacy labels for sorting and drops blanks", () => {
    expect(hubParts({ n: "Boston MA", z: "02101" })).toEqual({ st: "MA", city: "Boston" });
    expect(hubParts({ n: "", z: "27701" }, idx)).toEqual({ st: "NC", city: "Durham" });
    const out = normalizeHubs([{ n: "Durham NC", z: "27701" }, { n: "Boston MA", z: "02101" }, { n: "", z: "" }]);
    expect(out.map((h) => h.z)).toEqual(["02101", "27701"]);
  });
  it("puts entries with no known state last", () => {
    expect(normalizeHubs([{ n: "Mystery", z: "99999" }, D]).map((h) => h.z)).toEqual(["27701", "99999"]);
  });
  it("addHub refuses a duplicate", () => {
    expect(addHub([D], { n: "Durham NC", z: "27701" }).added).toBe(false);
    const r = addHub([D], B);
    expect(r.added).toBe(true);
    expect(r.hubs.map((h) => h.st)).toEqual(["MA", "NC"]);
  });
  it("hubFromZip accepts only 5 digits", () => {
    expect(hubFromZip("27701")).toEqual({ n: "27701", z: "27701" });
    expect(hubFromZip("2770")).toBeNull();
  });
});

describe("the shipped public/locations.txt", () => {
  const real = parseLocations(readFileSync(new URL("../public/locations.txt", import.meta.url), "utf8"));
  it("covers the app's default hubs", () => {
    expect(real.rows.length).toBeGreaterThan(40000);
    expect(searchLocations(real, "durham nc")[0].hub.st).toBe("NC");
    expect(real.byZip["02108"].city).toBe("Boston");
    expect(searchLocations(real, "louisville ky")[0].label).toBe("Louisville, KY");
  });
});

import { circleOverlap, hubOverlaps } from "../src/locations.js";
describe("search-area overlap", () => {
  it("circle overlap: identical = 1, far apart = 0, half-radius apart ≈ 69%", () => {
    expect(circleOverlap(0, 100, 100)).toBe(1);
    expect(circleOverlap(250, 100, 100)).toBe(0);
    expect(circleOverlap(100, 100, 100)).toBeCloseTo(0.391, 2);
    expect(circleOverlap(50, 100, 100)).toBeCloseTo(0.685, 2);
  });
  it("a small area inside a big one counts as fully covered", () => {
    expect(circleOverlap(20, 100, 30)).toBe(1);
  });
  it("flags Durham + Raleigh (about 23 mi apart) but not Durham + Boston", () => {
    const hubs = [
      { n: "Durham, NC", z: "27701", lat: 35.994, lon: -78.899 },
      { n: "Raleigh, NC", z: "27601", lat: 35.772, lon: -78.638 },
      { n: "Boston, MA", z: "02108", lat: 42.357, lon: -71.064 },
    ];
    const o = hubOverlaps(hubs);
    expect(o.length).toBe(1);
    expect([o[0].a.n, o[0].b.n]).toEqual(["Durham, NC", "Raleigh, NC"]);
    expect(o[0].miles).toBeGreaterThan(18);
    expect(o[0].miles).toBeLessThan(28);
    expect(o[0].overlap).toBeGreaterThan(0.8);
  });
  it("uses the ZIP index for legacy locations without coordinates, skips ones it can't place", () => {
    const o = hubOverlaps([{ n: "Durham NC", z: "27701" }, { n: "Durham", z: "27702" }, { n: "??", z: "00000" }], idx);
    expect(o.length).toBe(1);
  });
  it("respects a per-location radius", () => {
    const o = hubOverlaps([{ n: "A", lat: 35, lon: -78, r: 10 }, { n: "B", lat: 35.3, lon: -78, r: 10 }]); // ~21 mi apart, 10-mi circles
    expect(o).toEqual([]);
  });
});
