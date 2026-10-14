// Search-location helpers: parse the flat file, suggest matches, and keep the
// saved list deduped + sorted. Pure (no DOM / network) apart from loadLocations,
// so the rules are unit-testable.
//
// The flat file is public/locations.txt, built by scripts/build-locations.mjs
// from GeoNames postal codes (CC BY 4.0). One line per ZIP: ST|City|ZIP|lat|lon.

import { haversineMi } from "./geo.js";

let loading = null;

// Fetch + parse once; a failed load clears the cache so the next use retries.
export function loadLocations() {
  if (!loading) {
    loading = fetch("/locations.txt")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(parseLocations)
      .catch(function (e) { loading = null; throw e; });
  }
  return loading;
}

// text -> { rows, byZip, cities } where cities is one entry per (state, city)
// with a representative ZIP (the one nearest the city's centre) and a ZIP count.
export function parseLocations(text) {
  const rows = [];
  const byZip = {};
  String(text || "").split("\n").forEach(function (line) {
    const f = line.split("|");
    if (f.length < 5) return;
    const lat = parseFloat(f[3]), lon = parseFloat(f[4]);
    if (isNaN(lat) || isNaN(lon)) return;
    const r = { st: f[0], city: f[1], zip: f[2], lat: lat, lon: lon };
    rows.push(r);
    byZip[r.zip] = r;
  });
  const groups = {};
  rows.forEach(function (r) { (groups[r.st + "|" + r.city.toLowerCase()] = groups[r.st + "|" + r.city.toLowerCase()] || []).push(r); });
  const cities = Object.keys(groups).map(function (k) {
    const g = groups[k];
    const cLat = g.reduce(function (a, r) { return a + r.lat; }, 0) / g.length;
    const cLon = g.reduce(function (a, r) { return a + r.lon; }, 0) / g.length;
    let best = g[0], bestD = Infinity;
    g.forEach(function (r) { const d = (r.lat - cLat) * (r.lat - cLat) + (r.lon - cLon) * (r.lon - cLon); if (d < bestD) { bestD = d; best = r; } });
    return { st: best.st, city: best.city, zip: best.zip, lat: best.lat, lon: best.lon, zips: g.length, lc: best.city.toLowerCase() };
  });
  return { rows: rows, byZip: byZip, cities: cities };
}

function asHub(r) {
  return { n: r.city + ", " + r.st, c: r.city, st: r.st, z: r.zip, lat: r.lat, lon: r.lon };
}

// Suggestions for what the user has typed. A run of digits matches ZIPs by
// prefix; otherwise text matches city names ("durham", "durham nc",
// "Durham, NC"), best first: exact, then prefix, then any later word.
// Returns [{ key, label, sub, hub }].
export function searchLocations(index, query, limit) {
  const max = limit || 8;
  const q = String(query || "").trim();
  if (!index || !q) return [];

  if (/^\d+$/.test(q)) {
    return index.rows.filter(function (r) { return r.zip.indexOf(q) === 0; }).slice(0, max).map(function (r) {
      return { key: "z" + r.zip, label: r.city + ", " + r.st + " " + r.zip, sub: "", hub: asHub(r) };
    });
  }

  let text = q.toLowerCase(), st = "";
  const m = q.match(/^(.*\S)\s*[,\s]\s*([A-Za-z]{2})$/);
  if (m) { text = m[1].toLowerCase().replace(/[,\s]+$/, ""); st = m[2].toUpperCase(); }
  const scored = [];
  index.cities.forEach(function (c) {
    if (st && c.st !== st) return;
    let rank = -1;
    if (c.lc === text) rank = 0;
    else if (c.lc.indexOf(text) === 0) rank = 1;
    else if (c.lc.indexOf(" " + text) > -1) rank = 2;
    if (rank < 0) return;
    scored.push({ c: c, rank: rank });
  });
  scored.sort(function (a, b) {
    return a.rank - b.rank || b.c.zips - a.c.zips || a.c.city.localeCompare(b.c.city) || a.c.st.localeCompare(b.c.st);
  });
  return scored.slice(0, max).map(function (s) {
    const c = s.c;
    return { key: "c" + c.st + c.zip, label: c.city + ", " + c.st, sub: c.zip + (c.zips > 1 ? " · " + c.zips + " ZIPs" : ""), hub: asHub(c) };
  });
}

// Identity for dedupe: the ZIP when there is one, else the normalized label.
export function hubKey(h) {
  const z = String((h && h.z) || "").trim();
  if (z) return "z" + z;
  return "n" + String((h && h.n) || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// { st, city } for sorting and display. Prefers the stored fields, then parses a
// legacy "Boston MA" / "Boston, MA" label, then looks the ZIP up if we can.
export function hubParts(h, index) {
  if (h && h.st) return { st: h.st, city: h.c || h.n || "" };
  const n = String((h && h.n) || "").trim();
  const m = n.match(/^(.+?)[,\s]+([A-Za-z]{2})$/);
  if (m) return { st: m[2].toUpperCase(), city: m[1] };
  const r = index && h && index.byZip[String(h.z || "").trim()];
  if (r) return { st: r.st, city: r.city };
  return { st: "", city: n };
}

// Drop blanks, dedupe by hubKey (first wins, but fill in missing coordinates from
// a later duplicate), and sort by state then city then ZIP. Entries whose state
// can't be determined sort last, by label.
export function normalizeHubs(list, index) {
  const seen = {};
  const out = [];
  (list || []).forEach(function (h) {
    if (!h || (!String(h.z || "").trim() && !String(h.n || "").trim())) return;
    const k = hubKey(h);
    if (seen[k] != null) {
      const prev = out[seen[k]];
      if (prev.lat == null && h.lat != null) { prev.lat = h.lat; prev.lon = h.lon; }
      return;
    }
    seen[k] = out.length;
    out.push(Object.assign({}, h, { n: String(h.n || "").trim(), z: String(h.z || "").trim() }));
  });
  return out.map(function (h) { return { h: h, p: hubParts(h, index) }; }).sort(function (a, b) {
    if (!a.p.st !== !b.p.st) return a.p.st ? -1 : 1;
    return a.p.st.localeCompare(b.p.st) || a.p.city.localeCompare(b.p.city, undefined, { sensitivity: "base" }) || String(a.h.z).localeCompare(String(b.h.z));
  }).map(function (x) { return x.h; });
}

// Add a hub unless it's already listed. -> { hubs, added }
export function addHub(list, hub, index) {
  const k = hubKey(hub);
  if ((list || []).some(function (h) { return hubKey(h) === k; })) return { hubs: normalizeHubs(list, index), added: false };
  return { hubs: normalizeHubs((list || []).concat([hub]), index), added: true };
}

// Fallback when the location file can't load: accept a bare 5-digit ZIP.
export function hubFromZip(text) {
  const z = String(text || "").trim();
  return /^\d{5}$/.test(z) ? { n: z, z: z } : null;
}

// ── Overlapping search areas ──
// Each search location is its own MarketCheck query on every sync, so two whose
// circles mostly overlap pay twice for largely the same cars.

const DEFAULT_RADIUS_MI = 100; // api/marketcheck.js default (free tier max)

// Share of the SMALLER circle covered by the other (0..1).
export function circleOverlap(d, r1, r2) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return 1;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return Math.min(1, (a + b - c) / (Math.PI * Math.min(r1, r2) * Math.min(r1, r2)));
}

// Pairs of locations whose search areas overlap at least `threshold` (default
// half), most-overlapping first. Coordinates come from the hub, else the ZIP index.
export function hubOverlaps(hubs, index, threshold) {
  const min = threshold != null ? threshold : 0.5;
  const pts = (hubs || []).map(function (h) {
    const r = index && index.byZip && index.byZip[String(h.z || "").trim()];
    const lat = h.lat != null ? Number(h.lat) : r ? r.lat : null;
    const lon = h.lon != null ? Number(h.lon) : r ? r.lon : null;
    return { h: h, lat: lat, lon: lon, r: Number(h.r) || DEFAULT_RADIUS_MI };
  }).filter(function (p) { return p.lat != null && p.lon != null && isFinite(p.lat) && isFinite(p.lon); });
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = haversineMi(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon);
      const f = circleOverlap(d, pts[i].r, pts[j].r);
      if (f >= min) out.push({ a: pts[i].h, b: pts[j].h, miles: Math.round(d), overlap: f });
    }
  }
  return out.sort(function (x, y) { return y.overlap - x.overlap; });
}
