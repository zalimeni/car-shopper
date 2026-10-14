// Builds public/locations.txt — the flat file behind the search-location picker.
//
//   node scripts/build-locations.mjs <path-to-GeoNames-US.txt>
//
// Source: GeoNames postal codes, https://download.geonames.org/export/zip/US.zip
// (CC BY 4.0 — credit is shown in the picker). Unzip it and pass US.txt.
//
// Output is one line per ZIP, pipe-separated, sorted by state, city, ZIP:
//   ST|City|ZIP|lat|lon
// ~41k lines, loaded lazily by the browser (not bundled) and searched in memory.
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
if (!src) { console.error("usage: node scripts/build-locations.mjs <US.txt>"); process.exit(1); }

const rows = [];
for (const line of readFileSync(src, "utf8").split("\n")) {
  // country, zip, place, state name, state code, county, county code, community, community code, lat, lon, accuracy
  const f = line.split("\t");
  if (f.length < 11) continue;
  const zip = f[1].trim(), city = f[2].trim(), st = f[4].trim();
  const lat = parseFloat(f[9]), lon = parseFloat(f[10]);
  if (!/^\d{5}$/.test(zip) || !city || !/^[A-Z]{2}$/.test(st) || isNaN(lat) || isNaN(lon)) continue;
  rows.push({ st, city, zip, lat: lat.toFixed(3), lon: lon.toFixed(3) });
}
rows.sort((a, b) => a.st.localeCompare(b.st) || a.city.localeCompare(b.city) || a.zip.localeCompare(b.zip));
writeFileSync(new URL("../public/locations.txt", import.meta.url), rows.map(r => [r.st, r.city, r.zip, r.lat, r.lon].join("|")).join("\n") + "\n");
console.log("wrote " + rows.length + " locations");
