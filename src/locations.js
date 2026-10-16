// Location helpers for the home-base picker: parse the flat file and suggest
// matches. Pure (no DOM / network) apart from loadLocations, so they're unit-testable.
//
// The flat file is public/locations.txt, built by scripts/build-locations.mjs
// from GeoNames postal codes (CC BY 4.0). One line per ZIP: ST|City|ZIP|lat|lon.

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

// Fallback when the location file can't load: accept a bare 5-digit ZIP.
export function hubFromZip(text) {
  const z = String(text || "").trim();
  return /^\d{5}$/.test(z) ? { n: z, z: z } : null;
}

// ── Overlapping search areas ──
// Each search location is its own MarketCheck query on every sync, so two whose
// circles mostly overlap pay twice for largely the same cars.

const DEFAULT_RADIUS_MI = 100; // api/marketcheck.js default (free tier max)
