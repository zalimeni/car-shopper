// Straight-line distance between a listing's dealer and the buyer's home base.
// Import-free so both the browser and the serverless scorer can use it.

const R_MI = 3958.8; // mean Earth radius, miles

function num(v) { const n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && isFinite(n) ? n : null; }

export function haversineMi(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Whole miles from home base to the listing's dealer, or null when either end
// has no coordinates (older listings until their next sync; home base unset or
// saved before it carried coordinates).
export function homeMiles(listing, homeBase) {
  if (!listing || !homeBase) return null;
  const la = num(listing.dLat), lo = num(listing.dLon), hla = num(homeBase.lat), hlo = num(homeBase.lon);
  if (la == null || lo == null || hla == null || hlo == null) return null;
  return Math.round(haversineMi(hla, hlo, la, lo));
}
