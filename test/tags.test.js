import { describe, it, expect } from "vitest";
import { normalizeTag, hasTag, addTag, removeTag, allTags, TAG_MAX } from "../src/tags.js";

describe("tags", () => {
  it("normalizes whitespace and caps length", () => {
    expect(normalizeTag("  called   dealer ")).toBe("called dealer");
    expect(normalizeTag("x".repeat(50)).length).toBe(TAG_MAX);
    expect(normalizeTag(null)).toBe("");
  });
  it("adds once, case-insensitively, adopting a known tag's spelling", () => {
    expect(addTag(["Called dealer"], "called DEALER")).toEqual(["Called dealer"]);
    expect(addTag([], "test drive booked", ["Test drive booked"])).toEqual(["Test drive booked"]);
    expect(addTag(undefined, "  ")).toEqual([]);
    expect(addTag(["a"], "b")).toEqual(["a", "b"]);
  });
  it("removes case-insensitively", () => {
    expect(removeTag(["Called dealer", "Carfax"], "called dealer")).toEqual(["Carfax"]);
    expect(removeTag(undefined, "x")).toEqual([]);
  });
  it("hasTag matches case-insensitively", () => {
    expect(hasTag({ tags: ["Called dealer"] }, "CALLED DEALER")).toBe(true);
    expect(hasTag({}, "x")).toBe(false);
    expect(hasTag({ tags: ["a"] }, "")).toBe(false);
  });
  it("allTags lists each tag once, most-used first", () => {
    const ls = [{ tags: ["Carfax", "Called dealer"] }, { tags: ["called dealer"] }, { tags: ["Appraisal"] }, {}];
    expect(allTags(ls)).toEqual(["Called dealer", "Appraisal", "Carfax"]);
  });
});
