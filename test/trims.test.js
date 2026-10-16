import { describe, it, expect } from "vitest";
import { trimHideReason, trimState, setTrimState, nextTrimState, facetChoices, legacyTrimChips } from "../src/trims.js";

describe("trimHideReason", () => {
  it("hides an excluded trim exactly, case-insensitively", () => {
    expect(trimHideReason({ trim: "Limited XT" }, { excludeTrims: ["limited xt"] })).toEqual({ kind: "trim", text: "hidden trim: Limited XT" });
    expect(trimHideReason({ trim: "Limited" }, { excludeTrims: ["Limited XT"] })).toBeNull();
  });
  it("still honors the old fuzzy text filters", () => {
    expect(trimHideReason({ trim: "Touring XT" }, { trimExclude: "XT, Turbo" }).text).toBe("matches trim exclude: xt");
    expect(trimHideReason({ trim: "Base" }, { trimInclude: "Premium, Limited" }).text).toBe("trim not in include list");
  });
  it("hides an excluded drivetrain; unknown trims/drivetrains show", () => {
    expect(trimHideReason({ trim: "SEL FWD", drivetrain: "FWD" }, { excludeDrivetrains: ["FWD"] })).toEqual({ kind: "drivetrain", text: "hidden drivetrain: FWD" });
    expect(trimHideReason({ trim: "Brand New Trim" }, { excludeTrims: ["Blue HEV AWD"], excludeDrivetrains: ["FWD"] })).toBeNull();
    expect(trimHideReason({}, null)).toBeNull();
  });
});

describe("trim chip states", () => {
  it("cycles neutral → prefer → hide → neutral", () => {
    expect(nextTrimState(null)).toBe("prefer");
    expect(nextTrimState("prefer")).toBe("hide");
    expect(nextTrimState("hide")).toBeNull();
  });
  it("sets a state, keeping params.trims as the preferred list", () => {
    const p1 = setTrimState({}, "Limited HEV AWD", "prefer");
    expect(p1).toEqual({ preferTrims: ["Limited HEV AWD"], excludeTrims: [], trims: "Limited HEV AWD" });
    expect(trimState(p1, "limited hev awd")).toBe("prefer");
    const p2 = setTrimState(p1, "Limited HEV AWD", "hide");
    expect(p2).toEqual({ preferTrims: [], excludeTrims: ["Limited HEV AWD"], trims: "" });
    expect(trimState(setTrimState(p2, "Limited HEV AWD", null), "Limited HEV AWD")).toBeNull();
  });
});

describe("facetChoices", () => {
  it("facet values by count, then seen values it lacks, then kept ones; drops '-'", () => {
    const c = facetChoices({ counts: { "Limited": 1125, "Premium": 1109, "-": 113 } }, ["Base", "premium"], ["Wilderness"]);
    expect(c).toEqual([{ value: "Limited", count: 1125 }, { value: "Premium", count: 1109 }, { value: "Base", count: null }, { value: "Wilderness", count: 0 }]);
  });
  it("without a facet: seen values only", () => {
    expect(facetChoices(null, ["SEL AWD"], [])).toEqual([{ value: "SEL AWD", count: null }]);
  });
});

describe("legacyTrimChips", () => {
  const outback = ["Limited", "Premium", "Touring XT", "Limited XT", "Onyx Edition XT", "Touring", "Outback Wilderness", "Base"];
  it("turns fuzzy excludes + preferred text into chip states", () => {
    const r = legacyTrimChips({ trims: "Premium, Limited, Base", trimExclude: "XT, Turbo, Onyx, Wilderness" }, outback);
    expect(r.excludeTrims).toEqual(["Touring XT", "Limited XT", "Onyx Edition XT", "Outback Wilderness"]);
    expect(r.preferTrims).toEqual(["Limited", "Premium", "Base"]);
    expect(r.trims).toBe("Limited, Premium, Base");
    expect(r.trimExclude).toBe("");
  });
  it("an include list hides everything it doesn't match", () => {
    const r = legacyTrimChips({ trimInclude: "Limited" }, ["Limited AWD", "SEL AWD"]);
    expect(r.excludeTrims).toEqual(["SEL AWD"]);
  });
  it("keeps preferred text when no trim matches it; null when nothing to convert", () => {
    expect(legacyTrimChips({ trims: "LT w/ DC-II" }, ["LT", "Premier"]).trims).toBe("LT w/ DC-II");
    expect(legacyTrimChips({ preferTrims: ["LT"], trims: "LT" }, ["LT"])).toBeNull();
  });
});
