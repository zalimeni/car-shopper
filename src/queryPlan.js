// Profile fields -> MarketCheck query values. Pure and import-free (shared by the
// proxy's buildUrl and the sync planner's search signature).
//
// Each profile is searched on its own, nationwide. Profiles used to be merged into
// one query (make/model/year/powertrain_type all take lists), which paid off for
// many small per-location searches but backfires nationwide: a merged query can
// only keep the filters EVERY profile shares, so it widens. Measured live (Oct
// 2026): six profiles merged matched 7,824 cars; RAV4 Hybrid alone matched 67.

// Friendly powertrain words -> MarketCheck's powertrain_type codes. Unknowns pass through.
export function mapPowertrain(v) {
  const k = String(v || "").trim().toLowerCase();
  if (k === "hybrid" || k === "hev") return "HEV";
  if (k === "phev" || k === "plug-in hybrid" || k === "plugin hybrid" || k === "plug in hybrid") return "PHEV";
  if (k === "gas" || k === "gasoline" || k === "combustion") return "Combustion";
  if (k === "electric" || k === "ev" || k === "bev") return "BEV";
  if (k === "mild hybrid" || k === "mhev") return "MHEV";
  return v;
}

// "2019-2022" -> "2019,2020,2021,2022"; "2016, 2018" -> "2016,2018"
export function parseYears(s) {
  if (!s) return "";
  const out = [];
  String(s).split(",").forEach(function (part) {
    const t = part.trim();
    const range = t.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (range) {
      let a = +range[1], b = +range[2];
      if (a > b) { const tmp = a; a = b; b = tmp; }
      for (let y = a; y <= b; y++) out.push(y);
    } else if (/^\d{4}$/.test(t)) {
      out.push(+t);
    }
  });
  return Array.from(new Set(out)).sort().join(",");
}
