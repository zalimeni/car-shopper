import { describe, it, expect } from "vitest";
import { haversineMi, homeMiles } from "../src/geo.js";

const DURHAM = { n: "Durham, NC", z: "27701", lat: 35.997, lon: -78.897 };
const SHOALS = { dLat: "34.772847", dLon: "-87.669898" }; // Kia of The Shoals, Sheffield AL (string coords as MarketCheck sends)
const LOUISVILLE = { dLat: 38.255, dLon: -85.755 };
const AUSTIN = { dLat: 30.271, dLon: -97.743 };

describe("homeMiles", () => {
  it("measures real straight-line miles from the home base", () => {
    expect(homeMiles(SHOALS, DURHAM)).toBeGreaterThan(480);
    expect(homeMiles(SHOALS, DURHAM)).toBeLessThan(520);
    expect(homeMiles(LOUISVILLE, DURHAM)).toBeGreaterThan(380);
    expect(homeMiles(AUSTIN, DURHAM)).toBeGreaterThan(1100);
  });
  it("ranks a KY or TX dealer as far from Durham, not 'close' — the original complaint", () => {
    const near = homeMiles({ dLat: 35.9, dLon: -78.9 }, DURHAM);
    expect(near).toBeLessThan(15);
    expect(homeMiles(LOUISVILLE, DURHAM)).toBeGreaterThan(near * 20);
  });
  it("is null when either end lacks coordinates", () => {
    expect(homeMiles({}, DURHAM)).toBeNull();
    expect(homeMiles(SHOALS, null)).toBeNull();
    expect(homeMiles(SHOALS, { n: "Durham", z: "27701" })).toBeNull(); // home base saved before it carried coords
    expect(homeMiles({ dLat: "x", dLon: "y" }, DURHAM)).toBeNull();
  });
  it("is symmetric and zero for the same point", () => {
    expect(haversineMi(35, -78, 35, -78)).toBe(0);
    expect(haversineMi(35, -78, 40, -80)).toBeCloseTo(haversineMi(40, -80, 35, -78), 6);
  });
});
