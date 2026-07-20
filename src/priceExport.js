// Long-format price-history CSV export, for offline pricing analysis (e.g.
// feeding to Claude to reason about model/trim/mileage pricing). Pure — no DOM —
// so it's unit-testable; the actual file download lives in App.jsx.
//
// One row per price OBSERVATION across EVERY listing bucket — watchlist,
// rejected, sold, skipped, and candidate queues — so nothing (especially
// rejected listings) is left out of the historical record.

// Quote a CSV cell when it contains a comma, quote, or newline.
export function csvCell(v) {
  if (v == null) return "";
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isCpo(l) { return !!(l && (l.cpo === true || l.dealerType === "CPO")); }

// Gather every real observed listing across all buckets, deduped by VIN (first
// bucket wins, so a tracked listing's fuller history beats a one-shot candidate).
export function collectObserved(data, candidates) {
  var out = [], seen = {};
  function add(arr, statusOverride) {
    (arr || []).forEach(function (l) {
      if (!l) return;
      var key = (l.vin || "").trim().toUpperCase();
      if (key && seen[key]) return;
      if (key) seen[key] = true;
      out.push({ l: l, status: statusOverride || l.status || "" });
    });
  }
  add(data.listings, null);                 // watch / rejected / sold
  add(data.skipped, "skipped");
  add(candidates, "candidate");
  add(data.pendingCandidates, "candidate"); // cron-parked, not yet drained
  return out;
}

export var PRICE_CSV_COLUMNS = ["vin", "year", "vehicle", "trim", "mileage", "dealer_type", "cpo", "status", "reject_reason", "state", "location", "msrp", "dom", "profile", "observed_date", "price"];

// Returns { csv, points, listings }.
export function buildPriceHistoryCsv(data, candidates) {
  var profById = {};
  (data.profiles || []).forEach(function (p) { profById[p.id] = p; });
  var cols = PRICE_CSV_COLUMNS;
  var rows = [cols.join(",")];
  var points = 0, used = 0;
  collectObserved(data, candidates).forEach(function (o) {
    var l = o.l, prof = profById[l.profileId];
    var base = {
      vin: l.vin || "",
      year: l.year || "",
      vehicle: l.vehicle || (prof && prof.params ? ((prof.params.make || "") + " " + (prof.params.model || "")).trim() : ""),
      trim: l.trim || "",
      mileage: l.mileage != null ? l.mileage : "",
      dealer_type: l.dealerType || "",
      cpo: isCpo(l) ? "yes" : "",
      status: o.status,
      reject_reason: o.status === "rejected" ? (l.rejectReason || "") : "",
      state: l.state || "",
      location: l.location || "",
      msrp: l.msrp || "",
      dom: l.dom != null ? l.dom : "",
      profile: prof ? prof.name : "",
    };
    // One row per observed price; fall back to the current price when there's no
    // recorded history (dated by last-seen/added).
    var hist = (Array.isArray(l.priceHistory) && l.priceHistory.length)
      ? l.priceHistory
      : (l.price ? [{ date: l.lastSeen || l.addedDate || "", price: l.price }] : []);
    if (!hist.length) return;
    used++;
    hist.forEach(function (h) {
      points++;
      var row = Object.assign({}, base, { observed_date: h.date || "", price: h.price != null ? h.price : "" });
      rows.push(cols.map(function (c) { return csvCell(row[c]); }).join(","));
    });
  });
  return { csv: rows.join("\n"), points: points, listings: used };
}
