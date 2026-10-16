import { describe, it, expect } from "vitest";
import { baseColorOf, colorHideReason, colorChoices, COMMON_COLORS } from "../src/colors.js";

describe("baseColorOf", () => {
  it("prefers MarketCheck's base color", () => {
    expect(baseColorOf({ baseColor: "Gray", color: "Amazon Gray Metallic" })).toBe("Gray");
  });
  it("maps a marketing name for older listings", () => {
    expect(baseColorOf({ color: "Phantom Black Pearl" })).toBe("Black");
    expect(baseColorOf({ color: "Magnetic Gray Metallic" })).toBe("Gray");
    expect(baseColorOf({ color: "Lunar Silver" })).toBe("Silver");
    expect(baseColorOf({ color: "Super White" })).toBe("White");
    expect(baseColorOf({ color: "Autumn Green Metallic" })).toBe("Green");
  });
  it("null when no color is listed (or it can't be placed)", () => {
    expect(baseColorOf({})).toBeNull();
    expect(baseColorOf({ color: "" })).toBeNull();
    expect(baseColorOf({ color: "Cosmic Wonder" })).toBeNull();
  });
});

describe("colorHideReason", () => {
  it("hides excluded base colors, case-insensitively", () => {
    expect(colorHideReason({ baseColor: "Gold" }, { excludeColors: ["gold"] })).toBe("excluded color: Gold");
    expect(colorHideReason({ baseColor: "Blue" }, { excludeColors: ["Gold"] })).toBeNull();
  });
  it("keeps cars with no color listed unless the profile says otherwise", () => {
    expect(colorHideReason({}, { excludeColors: ["Gold"] })).toBeNull();
    expect(colorHideReason({}, { includeUnlistedColor: true })).toBeNull();
    expect(colorHideReason({}, { includeUnlistedColor: false })).toBe("no color listed");
  });
  it("no filter set: nothing hidden", () => {
    expect(colorHideReason({ baseColor: "Black" }, {})).toBeNull();
    expect(colorHideReason({ baseColor: "Black" }, null)).toBeNull();
  });
});

describe("colorChoices", () => {
  it("offers the facet's colors, most common first, then excluded ones it lacks", () => {
    const c = colorChoices({ counts: { Black: 261, White: 186, Gray: 204 } }, ["Gold"]);
    expect(c).toEqual([{ color: "Black", count: 261 }, { color: "Gray", count: 204 }, { color: "White", count: 186 }, { color: "Gold", count: 0 }]);
  });
  it("falls back to the common list before a facet exists", () => {
    expect(colorChoices(null, []).map((x) => x.color)).toEqual(COMMON_COLORS);
  });
});
