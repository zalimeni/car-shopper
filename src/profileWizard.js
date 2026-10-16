// The new-profile wizard's arithmetic. Pure, so it's unit-tested.
//
// The wizard asks MarketCheck once ("Explore") for the car's whole nationwide
// match set: a count, the trim / drivetrain / color / year facets, and price +
// mileage stats with percentiles (stats=price,miles — free plan). Everything here
// works off that one answer, so moving a cap or a year costs no calls.

import { parseYears } from "./queryPlan.js";

// Percentile points of a MarketCheck stat as [value, share] pairs, low to high:
// min → 0, "5.0" → 0.05 … "99.0" → 0.99, max → 1.
function points(stat) {
  if (!stat || stat.min == null || stat.max == null) return null;
  const pts = [[Number(stat.min), 0]];
  const pc = stat.percentiles || {};
  Object.keys(pc).map(function (k) { return [Number(pc[k]), parseFloat(k) / 100]; })
    .filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); })
    .sort(function (a, b) { return a[1] - b[1]; })
    .forEach(function (p) { pts.push(p); });
  pts.push([Number(stat.max), 1]);
  return pts;
}

// About what share of the cars are at or under `cap` (linear between
// percentiles) -> 0..1, or null without stats.
export function shareUnder(stat, cap) {
  const pts = points(stat);
  if (!pts || cap == null || !isFinite(cap)) return null;
  if (cap <= pts[0][0]) return 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (cap <= b[0]) return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (cap - a[0]) / (b[0] - a[0]);
  }
  return 1;
}

// Quick picks for a cap: the 25th / 50th / 75th / 90th percentiles, rounded UP to
// `step` (so the pick keeps at least that share). -> [{ value, share }]
export function capChoices(stat, step) {
  const pc = (stat && stat.percentiles) || {};
  const out = [];
  [["25.0", 0.25], ["50.0", 0.5], ["75.0", 0.75], ["90.0", 0.9]].forEach(function (k) {
    const v = Number(pc[k[0]]);
    if (!isFinite(v) || v <= 0) return;
    const r = Math.ceil(v / step) * step;
    if (!out.some(function (o) { return o.value === r; })) out.push({ value: r, share: k[1] });
  });
  return out;
}

// Roughly how many cars pass both caps, treating price and mileage as independent
// (they aren't quite — cheaper cars tend to have more miles — so it's a guide).
export function estimateMatches(total, stats, maxPrice, maxMiles) {
  if (total == null) return null;
  const s = stats || {};
  const sp = maxPrice ? shareUnder(s.price, maxPrice) : 1;
  const sm = maxMiles ? shareUnder(s.miles, maxMiles) : 1;
  if (sp == null || sm == null) return null;
  return Math.round(total * sp * sm);
}

// "2020-2022, 2024" from a list of years (ranges for consecutive runs).
export function formatYears(list) {
  const ys = Array.from(new Set((list || []).map(Number).filter(function (y) { return y > 1900; }))).sort(function (a, b) { return a - b; });
  const parts = [];
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    parts.push(j > i ? ys[i] + "-" + ys[j] : String(ys[i]));
    i = j;
  }
  return parts.join(", ");
}

export function yearList(years) { return parseYears(years).split(",").filter(Boolean).map(Number); }

// Add or drop one year from a profile's years text.
export function toggleYear(years, y) {
  const list = yearList(years);
  return formatYears(list.indexOf(y) > -1 ? list.filter(function (x) { return x !== y; }) : list.concat(y));
}

// Year chips from the explore's year facet (oldest first), marking which are in
// the profile's years. -> [{ year, count, on }]
export function yearChoices(facet, years) {
  const on = yearList(years);
  const counts = (facet && facet.counts) || {};
  return Object.keys(counts).map(Number).filter(function (y) { return y > 1900; }).sort(function (a, b) { return a - b; })
    .map(function (y) { return { year: y, count: counts[y], on: on.indexOf(y) > -1 }; });
}

// "Toyota RAV4 Hybrid" — the wizard's default profile name.
export function defaultName(params) {
  const p = params || {};
  return [p.make, p.model, p.powertrain].map(function (s) { return String(s || "").trim(); }).filter(Boolean).join(" ");
}
