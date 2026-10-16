import { describe, it, expect } from "vitest";
import { buildSuggestPrompt, buildSuggestSchema, coerceSuggestion } from "../api/_suggest.js";

describe("profile suggestion prompt", () => {
  it("states the vehicle and the market snapshot", () => {
    const t = buildSuggestPrompt({ params: { make: "Chevrolet", model: "Bolt EV", powertrain: "Electric", years: "2020-2023" } }, {
      count: 287, trims: { counts: { "LT Auto": 161, "2LT Auto": 98 } }, years: { counts: { 2022: 120 } },
      stats: { price: { median: 15995, percentiles: { "25.0": 14000, "75.0": 17500 } }, miles: { median: 41000 } }, homeBase: "Durham NC" });
    expect(t).toContain("Vehicle: Chevrolet Bolt EV (Electric)");
    expect(t).toContain("Years: 2020-2023");
    expect(t).toContain("Used listings nationwide right now: 287");
    expect(t).toContain("Trims listed: LT Auto (161), 2LT Auto (98)");
    expect(t).toContain("Asking price: median $15,995, middle half $14,000–$17,500");
    expect(t).toContain("Buyer is based in: Durham NC");
  });
  it("schema requires every field (structured output)", () => {
    const s = buildSuggestSchema();
    expect(s.required).toEqual(Object.keys(s.properties));
    expect(s.additionalProperties).toBe(false);
  });
});

describe("coerceSuggestion", () => {
  it("keeps well-formed parts only", () => {
    const r = coerceSuggestion({ mustHave: " battery replaced under recall ", avoidYears: [{ year: 2019, reason: "pre-recall pack" }, { year: "x" }], trimNotes: [{ trim: "", note: "x" }, { trim: "2LT", note: "heated seats" }] });
    expect(r).toEqual({ mustHave: "battery replaced under recall", niceToHave: "", dealbreakers: "", summary: "",
      avoidYears: [{ year: 2019, reason: "pre-recall pack" }], trimNotes: [{ trim: "2LT", note: "heated seats" }] });
    expect(coerceSuggestion(null).avoidYears).toEqual([]);
  });
});
