import { describe, it, expect } from "vitest";
import { layoutColumns, mergeOrder, moveColumn, togglePin } from "../src/compareCols.js";

const cols = ["score", "spec:price", "spec:miles", "cpo", "crit:a"].map((key) => ({ key }));
const keys = (l) => ({ pinned: l.pinned.map((c) => c.key), rest: l.rest.map((c) => c.key) });

describe("compare columns", () => {
  it("defaults to the given order, nothing pinned", () => {
    expect(keys(layoutColumns(cols, null))).toEqual({ pinned: [], rest: ["score", "spec:price", "spec:miles", "cpo", "crit:a"] });
  });
  it("applies the saved order and pins; ignores gone keys", () => {
    const l = layoutColumns(cols, { order: ["cpo", "gone", "score", "spec:price", "spec:miles", "crit:a"], pinned: ["spec:price", "gone"] });
    expect(keys(l)).toEqual({ pinned: ["spec:price"], rest: ["cpo", "score", "spec:miles", "crit:a"] });
  });
  it("slots new columns in after their default predecessor", () => {
    expect(mergeOrder(["score", "spec:price", "crit:new", "crit:a"], ["crit:a", "spec:price", "score"])).toEqual(["crit:a", "spec:price", "crit:new", "score"]);
    expect(mergeOrder(["first", "b"], ["b"])).toEqual(["first", "b"]);
  });
  it("moves a column onto another's spot", () => {
    const r = moveColumn(cols, null, "crit:a", "spec:price");
    expect(r.order).toEqual(["score", "crit:a", "spec:price", "spec:miles", "cpo"]);
    expect(r.pinned).toEqual([]);
  });
  it("dropping into / out of the pinned group pins / unpins", () => {
    const pref = { pinned: ["score"] };
    const into = moveColumn(cols, pref, "cpo", "score");
    expect(into.pinned).toEqual(["cpo", "score"]);
    const out = moveColumn(cols, into, "score", "spec:miles");
    expect(out.pinned).toEqual(["cpo"]);
    expect(out.order).toEqual(["cpo", "spec:price", "spec:miles", "score", "crit:a"]);
  });
  it("toggles a pin: pinned go last among pinned, unpinned go first among the rest", () => {
    const a = togglePin(cols, null, "cpo");
    expect(a).toEqual({ order: ["cpo", "score", "spec:price", "spec:miles", "crit:a"], pinned: ["cpo"] });
    const b = togglePin(cols, a, "crit:a");
    expect(b.pinned).toEqual(["cpo", "crit:a"]);
    expect(togglePin(cols, b, "cpo")).toEqual({ order: ["crit:a", "cpo", "score", "spec:price", "spec:miles"], pinned: ["crit:a"] });
  });
});
