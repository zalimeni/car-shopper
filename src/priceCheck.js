// Local-comps price check: given a query (year/make/model/trim/mileage/asking
// price) and the listings you've observed, find comparable cars and judge
// whether an asking price is fair vs. the local market you've actually seen.
// Pure (no DOM, no network) so it's unit-testable and free (0 API calls); the
// live MarketCheck-search path is layered on separately.

import { collectObserved } from "./priceExport.js";

// Representative price for a comp: latest recorded price, else current price.
export function repPrice(l) {
  if (l && Array.isArray(l.priceHistory) && l.priceHistory.length) {
    for (var i = l.priceHistory.length - 1; i >= 0; i--) {
      if (l.priceHistory[i] && l.priceHistory[i].price) return l.priceHistory[i].price;
    }
  }
  return (l && l.price) || 0;
}

// l.vehicle is "Make Model" (e.g. "Toyota RAV4"); require both tokens present.
function matchesModel(l, make, model) {
  var v = String(l.vehicle || "").toLowerCase();
  var mk = String(make || "").toLowerCase().trim();
  var md = String(model || "").toLowerCase().trim();
  if (!mk && !md) return false;
  if (mk && v.indexOf(mk) === -1) return false;
  if (md && v.indexOf(md) === -1) return false;
  return true;
}

// Percentile (linear-interpolated) over a sorted numeric array.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  var idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function priceStats(prices) {
  var xs = (prices || []).filter(function (p) { return p > 0; }).slice().sort(function (a, b) { return a - b; });
  if (!xs.length) return null;
  var sum = xs.reduce(function (a, b) { return a + b; }, 0);
  return {
    n: xs.length,
    min: xs[0],
    p25: Math.round(percentile(xs, 0.25)),
    median: Math.round(percentile(xs, 0.5)),
    p75: Math.round(percentile(xs, 0.75)),
    max: xs[xs.length - 1],
    mean: Math.round(sum / xs.length),
  };
}

// Fractional rank of `value` within `prices` (0..1), midpoint for ties.
function rankOf(value, prices) {
  var xs = prices.filter(function (p) { return p > 0; });
  if (!xs.length) return null;
  var below = 0, equal = 0;
  xs.forEach(function (p) { if (p < value) below++; else if (p === value) equal++; });
  return (below + equal * 0.5) / xs.length;
}

// Position an asking price against the comp distribution -> verdict + tone.
export function assess(asking, stats, prices) {
  if (!stats || !asking) return null;
  var tone, verdict;
  if (asking <= stats.p25) { verdict = "Great price"; tone = "good"; }
  else if (asking <= stats.median) { verdict = "Good — below the median"; tone = "good"; }
  else if (asking <= stats.p75) { verdict = "Fair — typical range"; tone = "ok"; }
  else { verdict = "High — above most comps"; tone = "high"; }
  return {
    verdict: verdict,
    tone: tone,
    rank: rankOf(asking, prices),
    vsMedian: asking - stats.median,
    pctVsMedian: stats.median ? (asking - stats.median) / stats.median : 0,
  };
}

// query: { vin?, year?, make?, model?, trim?, mileage?, askingPrice? }
// Returns { stats, verdict, comps, count, filtersUsed, mileageRange }.
export function localPriceCheck(data, candidates, query, opts) {
  opts = opts || {};
  query = query || {};
  var yearBand = opts.yearBand != null ? opts.yearBand : 1;
  var mileBand = opts.mileBand != null ? opts.mileBand : 20000;
  var minComps = opts.minComps != null ? opts.minComps : 3;
  var subjectVin = (query.vin || "").trim().toUpperCase();

  var observed = collectObserved(data || {}, candidates || []).map(function (o) { return o.l; });

  var base = observed.filter(function (l) {
    if (subjectVin && (l.vin || "").trim().toUpperCase() === subjectVin) return false; // exclude the car itself
    if (!matchesModel(l, query.make, query.model)) return false;
    if (query.year && l.year && Math.abs(l.year - query.year) > yearBand) return false;
    return repPrice(l) > 0;
  });

  var filtersUsed = ["make/model"];
  if (query.year) filtersUsed.push("year ±" + yearBand);
  var comps = base;

  // Narrow by mileage band only if it still leaves a usable sample.
  if (query.mileage) {
    var narrow = base.filter(function (l) { return l.mileage != null && Math.abs(l.mileage - query.mileage) <= mileBand; });
    if (narrow.length >= minComps) { comps = narrow; filtersUsed.push("mileage ±" + Math.round(mileBand / 1000) + "k"); }
  }
  // Prefer same trim only if it still leaves a usable sample.
  if (query.trim) {
    var qt = String(query.trim).toLowerCase().trim();
    var trimComps = comps.filter(function (l) {
      var t = String(l.trim || "").toLowerCase();
      return t && (t.indexOf(qt) > -1 || qt.indexOf(t) > -1);
    });
    if (trimComps.length >= minComps) { comps = trimComps; filtersUsed.push("trim"); }
  }

  var prices = comps.map(repPrice);
  var stats = priceStats(prices);
  var verdict = (query.askingPrice && stats) ? assess(query.askingPrice, stats, prices) : null;

  var mileages = comps.map(function (l) { return l.mileage; }).filter(function (m) { return m != null; });
  var mileageRange = mileages.length ? { min: Math.min.apply(null, mileages), max: Math.max.apply(null, mileages) } : null;

  // Closest comps (by mileage, then price) for display.
  var display = comps.slice().sort(function (a, b) {
    var am = query.mileage ? Math.abs((a.mileage || 0) - query.mileage) : repPrice(a);
    var bm = query.mileage ? Math.abs((b.mileage || 0) - query.mileage) : repPrice(b);
    return am - bm;
  }).slice(0, 8).map(function (l) {
    return {
      vin: l.vin || "", year: l.year, trim: l.trim || "", mileage: l.mileage,
      price: repPrice(l), status: l.status || "", dealerType: l.dealerType || "",
      cpo: !!(l.cpo === true || l.dealerType === "CPO"), state: l.state || "",
      date: l.lastSeen || l.addedDate || "",
    };
  });

  return { stats: stats, verdict: verdict, comps: display, count: comps.length, filtersUsed: filtersUsed, mileageRange: mileageRange };
}
