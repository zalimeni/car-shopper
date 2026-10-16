import { describe, it, expect } from "vitest";
import { trimHideReason, trimState, setTrimState, nextTrimState, facetChoices } from "../src/trims.js";

describe("trimHideReason", () => {
  it("hides an excluded trim exactly, case-insensitively", () => {
    expect(trimHideReason({ trim: "Limited XT" }, { excludeTrims: ["limited xt"] })).toEqual({ kind: "trim", text: "hidden trim: Limited XT" });
    expect(trimHideReason({ trim: "Limited" }, { excludeTrims: ["Limited XT"] })).toBeNull();
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
