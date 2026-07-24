import { describe, it, expect } from "vitest";
import { priceStats, assess, repPrice, localPriceCheck } from "../src/priceCheck.js";

describe("priceStats", () => {
  it("computes n/min/median/percentiles/max", () => {
    const s = priceStats([20000, 22000, 24000, 26000, 28000]);
    expect(s.n).toBe(5);
    expect(s.min).toBe(20000);
    expect(s.median).toBe(24000);
    expect(s.p25).toBe(22000);
    expect(s.p75).toBe(26000);
    expect(s.max).toBe(28000);
  });
  it("ignores non-positive prices and returns null when empty", () => {
    expect(priceStats([0, 0])).toBeNull();
    expect(priceStats([])).toBeNull();
    expect(priceStats([0, 10000]).n).toBe(1);
  });
});

describe("repPrice", () => {
  it("uses the latest non-zero history price, else current", () => {
    expect(repPrice({ priceHistory: [{ price: 26000 }, { price: 24500 }] })).toBe(24500);
    expect(repPrice({ priceHistory: [{ price: 0 }], price: 21000 })).toBe(21000);
    expect(repPrice({ price: 19000 })).toBe(19000);
  });
});

describe("assess", () => {
  const stats = { n: 5, min: 20000, p25: 22000, median: 24000, p75: 26000, max: 28000, mean: 24000 };
  const prices = [20000, 22000, 24000, 26000, 28000];
  it("flags a price at/below p25 as great", () => {
    expect(assess(21000, stats, prices).tone).toBe("good");
    expect(assess(21000, stats, prices).verdict).toBe("Great price");
  });
  it("flags typical range as fair and above-p75 as high", () => {
    expect(assess(25000, stats, prices).tone).toBe("ok");
    expect(assess(27500, stats, prices).tone).toBe("high");
  });
  it("reports the delta vs median", () => {
    const a = assess(27000, stats, prices);
    expect(a.vsMedian).toBe(3000);
    expect(Math.round(a.pctVsMedian * 100)).toBe(13);
  });
});

describe("localPriceCheck", () => {
  const data = {
    profiles: [{ id: "p1", name: "RAV4", params: { make: "Toyota", model: "RAV4" } }],
    listings: [
      { vin: "A", year: 2021, vehicle: "Toyota RAV4", trim: "XLE", mileage: 40000, price: 24000, status: "watch", profileId: "p1" },
      { vin: "B", year: 2021, vehicle: "Toyota RAV4", trim: "LE", mileage: 45000, price: 22500, status: "rejected", profileId: "p1" },
      { vin: "C", year: 2020, vehicle: "Toyota RAV4", trim: "XLE", mileage: 52000, price: 21000, status: "sold", profileId: "p1" },
      { vin: "D", year: 2021, vehicle: "Honda CR-V", trim: "EX", mileage: 41000, price: 25000, status: "watch", profileId: "p1" }, // different model
    ],
    skipped: [{ vin: "E", year: 2022, vehicle: "Toyota RAV4", trim: "XLE", mileage: 30000, price: 27000 }],
  };

  it("matches comps by make/model + year band across all buckets, excluding other models", () => {
    const r = localPriceCheck(data, [], { make: "Toyota", model: "RAV4", year: 2021, askingPrice: 26000 });
    // A, B, C (2020 within ±1), E (2022 within ±1) — not D (CR-V)
    expect(r.count).toBe(4);
    expect(r.stats.n).toBe(4);
    expect(r.comps.some((c) => c.vin === "D")).toBe(false);
  });

  it("excludes the subject VIN from its own comps", () => {
    const r = localPriceCheck(data, [], { vin: "A", make: "Toyota", model: "RAV4", year: 2021, askingPrice: 26000 });
    expect(r.count).toBe(3);
    expect(r.comps.some((c) => c.vin === "A")).toBe(false);
  });

  it("produces a verdict positioning the asking price", () => {
    const r = localPriceCheck(data, [], { make: "Toyota", model: "RAV4", year: 2021, askingPrice: 27000 });
    expect(r.verdict).toBeTruthy();
    expect(["ok", "high"]).toContain(r.verdict.tone); // 27000 is near/above the top of 21000-27000
    expect(r.filtersUsed).toContain("make/model");
  });

  it("returns no stats when there are no comparable listings", () => {
    const r = localPriceCheck(data, [], { make: "Subaru", model: "Outback", year: 2021, askingPrice: 26000 });
    expect(r.count).toBe(0);
    expect(r.stats).toBeNull();
    expect(r.verdict).toBeNull();
  });
});
