import { describe, it, expect } from "vitest";
import { buildPriceHistoryCsv, collectObserved, csvCell, PRICE_CSV_COLUMNS } from "../src/priceExport.js";

describe("csvCell", () => {
  it("quotes cells with commas, quotes, or newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });
});

describe("collectObserved", () => {
  it("pulls from every bucket and dedups by VIN (first bucket wins)", () => {
    const data = {
      listings: [{ vin: "A", status: "rejected" }, { vin: "B", status: "watch" }],
      skipped: [{ vin: "C" }, { vin: "A" }], // A already present -> ignored
      pendingCandidates: [{ vin: "D" }],
    };
    const got = collectObserved(data, [{ vin: "E" }]);
    // Order: listings, skipped, candidates, then cron-parked pendingCandidates.
    expect(got.map((o) => o.l.vin)).toEqual(["A", "B", "C", "E", "D"]);
    expect(got.find((o) => o.l.vin === "A").status).toBe("rejected");
    expect(got.find((o) => o.l.vin === "C").status).toBe("skipped");
    expect(got.find((o) => o.l.vin === "D").status).toBe("candidate");
    expect(got.find((o) => o.l.vin === "E").status).toBe("candidate");
  });
});

describe("buildPriceHistoryCsv", () => {
  const data = {
    profiles: [{ id: "p1", name: "RAV4 Hybrid", params: { make: "Toyota", model: "RAV4" } }],
    listings: [
      {
        vin: "VIN1", year: 2021, vehicle: "Toyota RAV4", trim: "XLE", mileage: 40000,
        dealerType: "franchise", cpo: true, status: "rejected", rejectReason: "too pricey",
        state: "MA", location: "Boston", msrp: 32000, dom: 20, profileId: "p1",
        priceHistory: [{ date: "2026-06-01", price: 26000 }, { date: "2026-06-20", price: 24500 }],
      },
      // No priceHistory -> falls back to current price dated by lastSeen.
      { vin: "VIN2", year: 2020, vehicle: "Toyota RAV4", trim: "LE", price: 22000, lastSeen: "2026-07-01", status: "sold", profileId: "p1" },
      // No price at all -> contributes no rows.
      { vin: "VIN3", year: 2019, vehicle: "Toyota RAV4", status: "watch", profileId: "p1" },
    ],
  };
  const out = buildPriceHistoryCsv(data, []);
  const lines = out.csv.split("\n");

  it("emits one row per price observation and counts them", () => {
    expect(out.points).toBe(3); // 2 from VIN1 + 1 from VIN2
    expect(out.listings).toBe(2); // VIN3 had no price, excluded
    expect(lines.length).toBe(1 + 3); // header + 3 rows
  });
  it("has the documented header", () => {
    expect(lines[0]).toBe(PRICE_CSV_COLUMNS.join(","));
  });
  it("includes rejected listings with their reason, CPO flag, and each price point", () => {
    const rav = lines.filter((l) => l.startsWith("VIN1,"));
    expect(rav).toHaveLength(2);
    expect(rav[0]).toContain("rejected");
    expect(rav[0]).toContain("too pricey");
    expect(rav[0]).toContain("yes"); // cpo
    expect(rav[0]).toContain("2026-06-01");
    expect(rav[0]).toContain("26000");
    expect(rav[1]).toContain("24500");
  });
  it("falls back to the current price when a listing has no history", () => {
    const v2 = lines.find((l) => l.startsWith("VIN2,"));
    expect(v2).toContain("2026-07-01");
    expect(v2).toContain("22000");
    expect(v2).toContain("sold");
  });
});
