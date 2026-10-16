// Exterior-color filtering, per profile. Pure, so it's unit-tested.
//
// MarketCheck gives each listing a normalized base color (base_ext_color:
// "Black", "Gray", "Green"…) next to the dealer's marketing name ("Phantom Black
// Pearl"). Some listings — often ones relayed by marketplaces — carry no color at
// all. Filtering happens on OUR side, after results arrive, so a color we didn't
// expect or a car with no color listed is never silently dropped by the search.
//
// profile.params.excludeColors: ["Gold", …] — hidden from candidates.
// profile.params.includeUnlistedColor: false hides cars with no color listed
//   (default true: kept, labelled "Color not listed").
// The choices a profile offers come from a facet (counts per base color across
// its whole nationwide match set), fetched when the profile is saved.

// Base colors MarketCheck uses (seen live: Black, Gray, White, Silver, Blue,
// Green, Red, Brown, Beige, Gold, Purple), plus a few that appear on other
// models. Used for the global defaults and before a profile has a facet.
export const COMMON_COLORS = ["Black", "White", "Gray", "Silver", "Blue", "Red", "Green", "Brown", "Beige", "Gold", "Orange", "Yellow", "Purple"];

// Older listings (synced before base colors were stored) only have the marketing
// name; map it by keyword. First match wins, so "Black Cherry" -> Black, which is
// MarketCheck's own habit too.
const KEYWORDS = [
  ["Black", /\b(black|ebony|onyx|obsidian|midnight)\b/], ["White", /\b(white|pearl white|ivory)\b/],
  ["Gray", /\b(gray|grey|graphite|gunmetal|charcoal|magnetic)\b/], ["Silver", /\b(silver|platinum)\b/],
  ["Blue", /\b(blue|navy)\b/], ["Red", /\b(red|maroon|burgundy|crimson|ruby)\b/], ["Green", /\b(green)\b/],
  ["Brown", /\b(brown|bronze)\b/], ["Beige", /\b(beige|tan|sand|champagne)\b/], ["Gold", /\b(gold)\b/],
  ["Orange", /\b(orange)\b/], ["Yellow", /\b(yellow)\b/], ["Purple", /\b(purple|violet)\b/],
];

// A listing's base color ("Black"…), or null when no color is listed.
export function baseColorOf(l) {
  if (l && l.baseColor) return String(l.baseColor);
  const t = String((l && l.color) || "").toLowerCase();
  if (!t) return null;
  const hit = KEYWORDS.find(function (k) { return k[1].test(t); });
  return hit ? hit[0] : null;
}

// Why a profile's color filter hides this listing, or null when it doesn't.
export function colorHideReason(l, params) {
  const p = params || {};
  const exc = (Array.isArray(p.excludeColors) ? p.excludeColors : []).map(function (c) { return String(c).toLowerCase(); });
  const base = baseColorOf(l);
  if (base && exc.indexOf(base.toLowerCase()) > -1) return "excluded color: " + base;
  if (!base && p.includeUnlistedColor === false) return "no color listed";
  return null;
}

// The colors a profile's editor offers: the facet's (most common first), then any
// excluded color the facet doesn't have (so it can still be un-excluded), else the
// common list. -> [{ color, count|null }]
export function colorChoices(facet, excluded) {
  const out = [];
  const seen = {};
  const push = function (c, n) { const k = String(c).toLowerCase(); if (!seen[k]) { seen[k] = true; out.push({ color: c, count: n }); } };
  const counts = (facet && facet.counts) || null;
  if (counts) Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (c) { push(c, counts[c]); });
  else COMMON_COLORS.forEach(function (c) { push(c, null); });
  (excluded || []).forEach(function (c) { push(c, counts ? 0 : null); });
  return out;
}
