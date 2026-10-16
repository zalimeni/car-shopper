import { describe, it, expect } from "vitest";
import { shareUnder, capChoices, estimateMatches, formatYears, rangeYears, yearOptions, yearChoices, defaultName } from "../src/profileWizard.js";

// Tucson Hybrid 2022-24, live (Oct 2026).
const price = { min: 11799, max: 41497, median: 28178,
  percentiles: { "5.0": 20200.6, "25.0": 25514, "50.0": 28178, "75.0": 30339, "90.0": 32590, "95.0": 33991.2, "99.0": 36554.48 } };
const miles = { min: 12, max: 175137, percentiles: { "5.0": 10887, "25.0": 24603, "50.0": 35832, "75.0": 53986, "90.0": 76832.2, "95.0": 90078.2, "99.0": 118956.88 } };

describe("shareUnder", () => {
  it("interpolates between percentiles", () => {
    expect(shareUnder(price, 28178)).toBeCloseTo(0.5);
    expect(shareUnder(price, (25514 + 28178) / 2)).toBeCloseTo(0.375);
    expect(shareUnder(price, 10000)).toBe(0);
    expect(shareUnder(price, 50000)).toBe(1);
    expect(shareUnder(null, 1)).toBeNull();
  });
});

describe("capChoices", () => {
  it("25/50/75/90th percentiles rounded up to the step", () => {
    expect(capChoices(price, 500)).toEqual([{ value: 26000, share: 0.25 }, { value: 28500, share: 0.5 }, { value: 30500, share: 0.75 }, { value: 33000, share: 0.9 }]);
    expect(capChoices(miles, 5000).map((c) => c.value)).toEqual([25000, 40000, 55000, 80000]);
    expect(capChoices(null, 500)).toEqual([]);
  });
});

describe("estimateMatches", () => {
  it("multiplies the two shares", () => {
    expect(estimateMatches(1001, { price, miles }, 28178, 35832)).toBe(250);
    expect(estimateMatches(1001, { price, miles }, 0, 0)).toBe(1001);
    expect(estimateMatches(null, { price }, 1, 0)).toBeNull();
  });
});

describe("years", () => {
  it("formats runs as ranges", () => {
    expect(formatYears([2024, 2020, 2021, 2022])).toBe("2020-2022, 2024");
    expect(formatYears([])).toBe("");
  });
  it("range minus skipped years; open ends take the market's bounds", () => {
    expect(rangeYears(2019, 2023, [2021])).toBe("2019-2020, 2022-2023");
    expect(rangeYears(2023, 2019, [])).toBe("2019-2023");
    expect(rangeYears("", "", [])).toBe("");
    expect(rangeYears(2020, "", [], { min: 2016, max: 2024 })).toBe("2020-2024");
    expect(rangeYears("", "", [2019], { min: 2017, max: 2020 })).toBe("2017-2018, 2020");
    expect(rangeYears(2020, "", [])).toBe(""); // open end, no market yet: any year
  });
  it("year options: next model year down", () => {
    expect(yearOptions(2024, new Date("2026-10-16"))).toEqual([2027, 2026, 2025, 2024]);
  });
  it("year chips from the facet, oldest first, inside the range", () => {
    const f = { counts: { "2022": 1485, "2020": 1359, "2021": 1072, "2019": 9 } };
    expect(yearChoices(f, "2020, 2022", 2020, 2022)).toEqual([
      { year: 2020, count: 1359, on: true }, { year: 2021, count: 1072, on: false }, { year: 2022, count: 1485, on: true }]);
    expect(yearChoices(f, "").length).toBe(4);
  });
  it("default name", () => {
    expect(defaultName({ make: "Hyundai", model: "Tucson", powertrain: "Hybrid" })).toBe("Hyundai Tucson Hybrid");
  });
});
