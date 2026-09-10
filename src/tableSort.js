// Shared column sorting for the app's table views (Compare, Price Check comps).
//
// Pure and dependency-free so the ordering rules are unit-testable and stay
// identical everywhere a table gains sortable headers.
//
// A "column" here is any object with a `get(row)` accessor, a stable `key`, and
// optionally `best: "min" | "max"` — the direction whose extreme is the most
// desirable value (cheapest price, highest score). That drives which way a
// column sorts the first time you click it.

// null / undefined / "" / NaN all mean "no value". These sort last in BOTH
// directions, so flipping a column never floats a wall of blanks to the top.
export function isBlank(v) {
  return v == null || v === "" || (typeof v === "number" && isNaN(v));
}

// Compare two present values: numbers numerically, booleans false < true, and
// everything else as a natural-order string so "XLE 2" precedes "XLE 10".
export function compareValues(a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// Which way a column sorts on its first click: "best value first". Score-like
// columns open high-to-low; price/mileage and plain text open low-to-high.
export function defaultDir(col) {
  return col && col.best === "max" ? "desc" : "asc";
}

// Header click: re-clicking the active column flips it, a new column opens in
// its natural direction.
export function nextSort(prev, col) {
  if (prev && prev.key === col.key) return { key: col.key, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { key: col.key, dir: defaultDir(col) };
}

// Copy of `rows` ordered by `col`, blanks last. A null column returns the rows
// untouched. Relies on Array#sort being stable, so ties keep their prior order.
export function sortRows(rows, col, dir) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!col || typeof col.get !== "function") return list;
  const mul = dir === "asc" ? 1 : -1;
  return list.sort(function (a, b) {
    const av = col.get(a), bv = col.get(b);
    const ab = isBlank(av), bb = isBlank(bv);
    if (ab && bb) return 0;
    if (ab) return 1;
    if (bb) return -1;
    return mul * compareValues(av, bv);
  });
}

// "▲" / "▼" for the active column, "" otherwise.
export function sortIndicator(sort, col) {
  if (!sort || !col || sort.key !== col.key) return "";
  return sort.dir === "asc" ? " ▲" : " ▼";
}
