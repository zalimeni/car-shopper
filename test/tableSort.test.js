import { describe, it, expect } from "vitest";
import { isBlank, compareValues, defaultDir, nextSort, sortRows, sortIndicator } from "../src/tableSort.js";

const price = { key: "price", label: "Price", best: "min", get: (r) => r.price };
const score = { key: "score", label: "Score", best: "max", get: (r) => r.score };
const trim = { key: "trim", label: "Trim", get: (r) => r.trim };

describe("isBlank", () => {
  it("treats null, undefined, empty string and NaN as absent", () => {
    [null, undefined, "", NaN].forEach((v) => expect(isBlank(v)).toBe(true));
  });
  it("keeps 0 and false as real values", () => {
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
  });
});

describe("compareValues", () => {
  it("orders numbers numerically, not lexically", () => {
    expect(compareValues(9, 10)).toBeLessThan(0);
  });
  it("orders booleans false before true", () => {
    expect(compareValues(false, true)).toBeLessThan(0);
  });
  it("orders strings naturally, so XLE 2 precedes XLE 10", () => {
    expect(compareValues("XLE 2", "XLE 10")).toBeLessThan(0);
  });
  it("compares strings case-insensitively", () => {
    expect(compareValues("limited", "Limited")).toBe(0);
  });
});

describe("defaultDir / nextSort", () => {
  it("opens a best-is-high column high-to-low and others low-to-high", () => {
    expect(defaultDir(score)).toBe("desc");
    expect(defaultDir(price)).toBe("asc");
    expect(defaultDir(trim)).toBe("asc");
  });
  it("flips direction when the active column is clicked again", () => {
    expect(nextSort({ key: "price", dir: "asc" }, price)).toEqual({ key: "price", dir: "desc" });
    expect(nextSort({ key: "price", dir: "desc" }, price)).toEqual({ key: "price", dir: "asc" });
  });
  it("opens a newly clicked column in its own natural direction", () => {
    expect(nextSort({ key: "price", dir: "desc" }, score)).toEqual({ key: "score", dir: "desc" });
  });
});

describe("sortRows", () => {
  const rows = [
    { vin: "A", price: 24000, score: 7, trim: "XLE" },
    { vin: "B", price: 21000, score: 9, trim: "LE" },
    { vin: "C", price: 27000, score: 5, trim: "Limited" },
  ];
  const vins = (rs) => rs.map((r) => r.vin).join("");

  it("sorts ascending and descending", () => {
    expect(vins(sortRows(rows, price, "asc"))).toBe("BAC");
    expect(vins(sortRows(rows, price, "desc"))).toBe("CAB");
  });
  it("does not mutate the input", () => {
    const copy = rows.slice();
    sortRows(rows, price, "desc");
    expect(rows).toEqual(copy);
  });
  it("returns rows untouched when no column is active", () => {
    expect(vins(sortRows(rows, null, "asc"))).toBe("ABC");
  });

  it("keeps rows missing the value at the bottom in BOTH directions", () => {
    const withGaps = [
      { vin: "A", price: 24000 },
      { vin: "B" },              // no price at all
      { vin: "C", price: 21000 },
      { vin: "D", price: null },
    ];
    expect(vins(sortRows(withGaps, price, "asc")).slice(0, 2)).toBe("CA");
    expect(vins(sortRows(withGaps, price, "desc")).slice(0, 2)).toBe("AC");
    // Blanks never lead, whichever way the column points.
    ["asc", "desc"].forEach((dir) => {
      const out = sortRows(withGaps, price, dir);
      expect(out.slice(-2).every((r) => r.price == null)).toBe(true);
    });
  });

  it("is stable, so ties keep the order they came in", () => {
    const tied = [{ vin: "A", score: 5 }, { vin: "B", score: 5 }, { vin: "C", score: 5 }];
    expect(vins(sortRows(tied, score, "desc"))).toBe("ABC");
  });

  it("sorts a boolean column with the true rows last when ascending", () => {
    const cpo = { key: "cpo", label: "CPO", get: (r) => !!r.cpo };
    const rs = [{ vin: "A", cpo: true }, { vin: "B", cpo: false }];
    expect(vins(sortRows(rs, cpo, "asc"))).toBe("BA");
  });
});

describe("sortIndicator", () => {
  it("marks only the active column, with the direction arrow", () => {
    expect(sortIndicator({ key: "price", dir: "asc" }, price)).toBe(" ▲");
    expect(sortIndicator({ key: "price", dir: "desc" }, price)).toBe(" ▼");
    expect(sortIndicator({ key: "price", dir: "asc" }, score)).toBe("");
    expect(sortIndicator(null, price)).toBe("");
  });
});
