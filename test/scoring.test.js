import { describe, it, expect } from "vitest";
import { buildScoreSchema, buildUserPrompt, coerceResult, resolveScoreModel, SCORE_MODELS, resolveBaselineBands, SCORE_SYSTEM } from "../api/_scoring.js";

describe("resolveBaselineBands", () => {
  const baseline = {
    refMileage: 60000, perThousandMi: 100,
    tiers: [{ years: "2019-2020", trim: "XLE", good: 20000, fair: 22000, high: 24000 }],
    default: { good: 18000, fair: 21000, high: 24000 },
  };
  it("matches a tier by year range + fuzzy trim and adjusts for mileage", () => {
    // 2019 XLE at 70k mi (10k over ref) -> subtract 10 * $100 = $1000
    const b = resolveBaselineBands(baseline, 2019, "Hybrid XLE AWD", 70000);
    expect(b).toEqual({ good: 19000, fair: 21000, high: 23000, matchedTier: true });
  });
  it("falls back to the default band when no tier matches", () => {
    const b = resolveBaselineBands(baseline, 2022, "Limited", 60000);
    expect(b).toEqual({ good: 18000, fair: 21000, high: 24000, matchedTier: false });
  });
  it("returns null without a baseline", () => {
    expect(resolveBaselineBands(null, 2020, "XLE", 60000)).toBeNull();
  });
});

const CRIT = [
  { id: "price", name: "Price vs. budget", weight: 25 },
  { id: "mileage", name: "Mileage vs. age", weight: 15 },
  { id: "deal", name: "Deal rating", weight: 10 },
];

describe("resolveScoreModel", () => {
  it("accepts an allowlisted model", () => {
    expect(resolveScoreModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveScoreModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
  it("falls back to the Sonnet default for anything not allowlisted", () => {
    expect(resolveScoreModel("gpt-4")).toBe("claude-sonnet-5");
    expect(resolveScoreModel("")).toBe("claude-sonnet-5");
    expect(resolveScoreModel(undefined)).toBe("claude-sonnet-5");
    expect(resolveScoreModel("claude-sonnet-4-6")).toBe("claude-sonnet-5"); // retired option -> default
    expect(resolveScoreModel("constructor")).toBe("claude-sonnet-5"); // not a real entry despite being on Object.prototype
  });
  it("default is Sonnet 5 and is itself allowlisted", () => {
    expect(SCORE_MODELS["claude-sonnet-5"]).toBeTruthy();
  });
});

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
    expect(p).toContain("Carfax: 1-owner confirmed");
    expect(p).toContain("MSRP: $32,000");
    expect(p).toContain("-3%");
  });
  it("includes the profile and only active requirements", () => {
    expect(p).toContain("Must have: AWD");
    expect(p).toContain("Clean title");
    expect(p).not.toContain("ignored");
  });
  it("uses a criterion's custom guidance override when present", () => {
    const crit = [{ id: "price", name: "Price", weight: 25, guidance: "10 = below $20k for this year" }];
    const out = buildUserPrompt(listing, { criteria: crit });
    expect(out).toContain("10 = below $20k for this year");
  });
});

// A trim ABOVE the buyer's preferred ones is upside, not a miss: it must not be
// scored down as the "wrong trim", and at a comparable price it should win.
describe("higher trims are upside, not a penalty", () => {
  const listing = { year: 2021, vehicle: "Subaru Outback", trim: "Touring", price: 24000, mileage: 38000 };
  const ctx = {
    criteria: [{ id: "features", name: "Features", weight: 20 }, { id: "price", name: "Price", weight: 25 }],
    profile: { name: "Outback", params: { make: "Subaru", model: "Outback", trims: "Base, Premium" } },
  };
  const p = buildUserPrompt(listing, ctx);

  it("presents the preferred trims as a floor rather than a whitelist", () => {
    expect(p).toContain("Preferred trims: Base, Premium");
    expect(p).toContain("floor, not a whitelist");
    expect(p).not.toContain("Acceptable trims");
  });
  it("omits the trim-handling note when the profile lists no trims", () => {
    const out = buildUserPrompt(listing, { criteria: ctx.criteria, profile: { params: { make: "Subaru" } } });
    expect(out).not.toContain("floor, not a whitelist");
  });
  it("no longer tells the model a richer trim is the wrong trim", () => {
    expect(p).not.toContain("wrong trim");
    expect(p).toContain("never a penalty");
  });
  it("anchors the price criterion on the listing's own trim", () => {
    expect(p).toContain("THAT trim/mileage");
  });
  it("warns not to price a richer trim against a fallback band", () => {
    const baseline = { refMileage: 40000, perThousandMi: 100, default: { good: 20000, fair: 22000, high: 24000 }, tiers: [] };
    const withBase = buildUserPrompt(listing, Object.assign({}, ctx, {
      profile: { name: "Outback", params: { make: "Subaru", trims: "Base, Premium", priceBaseline: baseline } },
    }));
    expect(withBase).toContain("no baseline tier matches this listing's trim");
    expect(withBase).toContain("floor, not a ceiling");
  });
  it("keeps the plain anchor when a tier does match the trim", () => {
    const baseline = { refMileage: 40000, perThousandMi: 100, default: { good: 20000, fair: 22000, high: 24000 },
      tiers: [{ years: "2021", trim: "Touring", good: 25000, fair: 27000, high: 29000 }] };
    const withBase = buildUserPrompt(listing, Object.assign({}, ctx, {
      profile: { name: "Outback", params: { make: "Subaru", trims: "Base, Premium", priceBaseline: baseline } },
    }));
    expect(withBase).not.toContain("no baseline tier matches");
  });
});

describe("SCORE_SYSTEM trim ladder", () => {
  it("states the ladder rule and that equal-priced richer trims score higher", () => {
    expect(SCORE_SYSTEM).toContain("preferred floor, not");
    expect(SCORE_SYSTEM).toContain("should score higher");
    expect(SCORE_SYSTEM).toContain("Only a trim BELOW");
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
