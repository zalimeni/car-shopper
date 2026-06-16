import { describe, it, expect } from "vitest";
import { buildScoreSchema, buildUserPrompt, coerceResult } from "../api/_scoring.js";

const CRIT = [
  { id: "price", name: "Price vs. budget", weight: 25 },
  { id: "mileage", name: "Mileage vs. age", weight: 15 },
  { id: "deal", name: "Deal rating", weight: 10 },
];

describe("buildScoreSchema", () => {
  it("requires every criterion id and constrains scores to 1-10", () => {
    const s = buildScoreSchema(CRIT);
    expect(s.properties.criteria.required).toEqual(["price", "mileage", "deal"]);
    expect(s.required).toEqual(["criteria", "summary"]);
    expect(s.properties.criteria.properties.price.properties.score.enum).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.properties.criteria.properties.price.additionalProperties).toBe(false);
  });
});

describe("buildUserPrompt", () => {
  const listing = {
    year: 2021, vehicle: "Toyota RAV4", trim: "XLE", price: 24000, mileage: 38000,
    dealer: "Best Toyota", dealerType: "CPO", location: "Boston", state: "MA", color: "Blue",
    msrp: 32000, carfax_1_owner: true, carfax_clean_title: true, price_change_percent: -3,
  };
  const ctx = {
    criteria: CRIT,
    profile: { name: "RAV4 Hybrid", params: { make: "Toyota", model: "RAV4", maxPrice: 25000, mustHave: "AWD" } },
    globalReqs: [{ id: "clean", text: "Clean title", active: true }, { id: "off", text: "ignored", active: false }],
  };
  const p = buildUserPrompt(listing, ctx);

  it("lists every criterion id in the rubric", () => {
    expect(p).toContain("price (");
    expect(p).toContain("mileage (");
    expect(p).toContain("deal (");
  });
  it("includes listing facts including Carfax/MSRP extras", () => {
    expect(p).toContain("$24,000");
    expect(p).toContain("38,000 mi");
    expect(p).toContain("Carfax 1-owner: yes");
    expect(p).toContain("MSRP: $32,000");
    expect(p).toContain("-3%");
  });
  it("includes the profile and only active requirements", () => {
    expect(p).toContain("Must have: AWD");
    expect(p).toContain("Clean title");
    expect(p).not.toContain("ignored");
  });
});

describe("coerceResult", () => {
  it("clamps out-of-range scores and trims rationale", () => {
    const parsed = {
      criteria: {
        price: { score: 12, rationale: "  great price  " },
        mileage: { score: 0, rationale: "low" },
        deal: { score: 7, rationale: "fair" },
      },
      summary: "  solid buy  ",
    };
    const r = coerceResult(parsed, CRIT);
    expect(r.scores).toEqual({ price: 10, mileage: 1, deal: 7 });
    expect(r.rationales.price).toBe("great price");
    expect(r.summary).toBe("solid buy");
  });
  it("returns null when a required criterion is missing", () => {
    const parsed = { criteria: { price: { score: 8, rationale: "x" }, mileage: { score: 5, rationale: "y" } }, summary: "" };
    expect(coerceResult(parsed, CRIT)).toBeNull();
  });
  it("rounds fractional scores", () => {
    const parsed = { criteria: { price: { score: 7.6, rationale: "" }, mileage: { score: 4.2, rationale: "" }, deal: { score: 5.5, rationale: "" } }, summary: "" };
    expect(coerceResult(parsed, CRIT).scores).toEqual({ price: 8, mileage: 4, deal: 6 });
  });
});
