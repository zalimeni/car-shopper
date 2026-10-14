// How a sync turns profiles into MarketCheck queries. Pure and import-free, so the
// server (api/marketcheck.js) and the quota gauge (src/quota.js) share one source
// of truth for what a sync costs.
//
// Every MarketCheck request counts against the account's monthly quota, whatever
// it returns. So instead of one query per profile, profiles are MERGED: make /
// model / year accept comma-separated lists, so one query per location can cover
// several profiles, with results sorted back to their profile locally. That
// includes powertrain_type (verified live: "HEV,PHEV" returns both), so every
// active profile shares one query; each row's own powertrain is checked locally.

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

// Profiles -> arrays of profiles that share one query. Every filter takes a list,
// so that's all of them together (a group too big to page completely is split back
// into single profiles by the server). Kept as a list of groups so callers needn't care.
export function groupProfiles(profiles) {
  const list = (profiles || []).filter(Boolean);
  return list.length ? [list] : [];
}

function present(v) { return v != null && String(v).trim() !== ""; }
function uniq(list) {
  const seen = {}, out = [];
  list.forEach(function (v) { const k = String(v).trim().toLowerCase(); if (!seen[k]) { seen[k] = true; out.push(String(v).trim()); } });
  return out;
}

// The single profile a group's query is built from. A filter is applied only when
// EVERY profile in the group sets it (otherwise the query would wrongly exclude a
// profile's cars); limits take the widest value. matchesProfile() then applies each
// profile's own filters locally. A one-profile group is returned unchanged.
export function mergedProfile(group) {
  if (!group || !group.length) return null;
  if (group.length === 1) return group[0];
  const ps = group.map(function (p) { return p.params || {}; });
  const all = function (f) { return ps.every(function (x) { return present(x[f]); }); };
  const params = {};
  if (all("make")) params.make = uniq(ps.map(function (x) { return x.make; })).join(",");
  if (all("model")) params.model = uniq(ps.map(function (x) { return x.model; })).join(",");
  if (all("years")) {
    const ys = {};
    ps.forEach(function (x) { parseYears(x.years).split(",").filter(Boolean).forEach(function (y) { ys[y] = true; }); });
    params.years = Object.keys(ys).sort().join(",");
  }
  if (all("maxPrice")) params.maxPrice = Math.max.apply(null, ps.map(function (x) { return Number(x.maxPrice) || 0; }));
  if (all("maxMiles")) params.maxMiles = Math.max.apply(null, ps.map(function (x) { return Number(x.maxMiles) || 0; }));
  if (all("powertrain")) params.powertrain = uniq(ps.map(function (x) { return mapPowertrain(x.powertrain); })).join(",");
  return { id: group.map(function (p) { return p.id; }).join("+"), name: group.map(function (p) { return p.name || p.id; }).join(" + "), params: params };
}

const squash = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };

// Does a raw MarketCheck row satisfy one profile's own filters? `loose` lets a
// model name match when one contains the other ("RAV4" vs "RAV4 Hybrid").
// Price is compared as MarketCheck quoted it, since that's what price_range filters on.
export function matchesProfile(row, profile, loose) {
  const x = (profile && profile.params) || {};
  const b = (row && row.build) || {};
  if (present(x.make) && squash(b.make) !== squash(x.make)) return false;
  if (present(x.model)) {
    const a = squash(b.model), m = squash(x.model);
    if (!a) return false;
    if (a !== m && !(loose && (a.indexOf(m) > -1 || m.indexOf(a) > -1))) return false;
  }
  if (present(x.powertrain) && present(b.powertrain_type) && squash(b.powertrain_type) !== squash(mapPowertrain(x.powertrain))) return false;
  const yrs = parseYears(x.years);
  if (yrs && yrs.split(",").indexOf(String(b.year)) === -1) return false;
  const price = Number(row && row.price) || 0;
  if (x.maxPrice && price && price > Number(x.maxPrice)) return false;
  const miles = Number(row && row.miles);
  if (x.maxMiles && isFinite(miles) && miles > Number(x.maxMiles)) return false;
  return true;
}

// The group profile a row belongs to: an exact model match first, then a loose one.
// A lone profile takes whatever MarketCheck returned for it, exactly as before
// merging existed. null = the row only matched the merged query's union of filters.
export function attributeRow(row, group) {
  if (!group || !group.length) return null;
  if (group.length === 1) return group[0];
  for (const p of group) if (matchesProfile(row, p, false)) return p;
  for (const p of group) if (matchesProfile(row, p, true)) return p;
  return null;
}
