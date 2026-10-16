// Per-profile trim + drivetrain chips, the same model as colors (src/colors.js):
// the choices come from a facet of the profile's whole nationwide match set, and
// filtering happens on OUR side, so a trim nobody has seen yet still shows.
// Pure, so it's unit-tested.
//
// Trims are MarketCheck's `version` ("SEL Convenience HEV AWD", "Limited XT") —
// what cards show, and fine enough to tell an Outback XT from a Limited. Each
// trim chip has three states: neutral, ★ preferred (scoring treats it as the
// floor — `params.trims` is kept as their comma-joined text for the scorer), or
// hidden. Drivetrains ("4WD" — MarketCheck's word for AWD — "FWD", "RWD") are
// hide-only.
//
// profile.params:
//   preferTrims: [trim]        ★ — also mirrored into params.trims
//   excludeTrims: [trim]       hidden from candidates
//   excludeDrivetrains: [dt]   hidden from candidates
//   trimInclude / trimExclude  the old fuzzy text filters — still honored until
//                              the editor converts them to chips (legacyTrimChips)

const key = function (s) { return String(s == null ? "" : s).trim().toLowerCase(); };
const has = function (list, v) { const k = key(v); return !!k && (list || []).some(function (x) { return key(x) === k; }); };
const terms = function (s) { return String(s || "").split(",").map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean); };

// Old fuzzy filters: a term matches if it's anywhere in the trim (or vehicle) text.
export function legacyTrimHide(l, params) {
  const p = params || {};
  const t = ((l && l.trim) || "") + " " + ((l && l.vehicle) || "");
  const tl = t.toLowerCase();
  const exc = terms(p.trimExclude).filter(function (e) { return tl.indexOf(e) > -1; });
  if (exc.length) return "matches trim exclude: " + exc.join(", ");
  const inc = terms(p.trimInclude);
  if (inc.length && !inc.some(function (e) { return tl.indexOf(e) > -1; })) return "trim not in include list";
  return null;
}

// Why the profile's trim/drivetrain chips hide this listing, or null.
// -> { kind: "trim" | "drivetrain", text } | null
export function trimHideReason(l, params) {
  const p = params || {};
  if (l && l.trim && has(p.excludeTrims, l.trim)) return { kind: "trim", text: "hidden trim: " + l.trim };
  const legacy = legacyTrimHide(l, p);
  if (legacy) return { kind: "trim", text: legacy };
  if (l && l.drivetrain && has(p.excludeDrivetrains, l.drivetrain)) return { kind: "drivetrain", text: "hidden drivetrain: " + l.drivetrain };
  return null;
}

export function trimState(params, trim) {
  const p = params || {};
  if (has(p.excludeTrims, trim)) return "hide";
  if (has(p.preferTrims, trim)) return "prefer";
  return null;
}

// Set a trim's state -> the params patch { preferTrims, excludeTrims, trims }.
export function setTrimState(params, trim, state) {
  const p = params || {};
  const drop = function (list) { return (list || []).filter(function (x) { return key(x) !== key(trim); }); };
  const prefer = drop(p.preferTrims), exclude = drop(p.excludeTrims);
  if (state === "prefer") prefer.push(trim);
  if (state === "hide") exclude.push(trim);
  return { preferTrims: prefer, excludeTrims: exclude, trims: prefer.join(", ") };
}

// Tapping a chip cycles neutral → ★ prefer → hidden → neutral.
export function nextTrimState(state) { return state === "prefer" ? "hide" : state === "hide" ? null : "prefer"; }

// The chips a profile offers: the facet's values (most common first), then values
// seen on its synced cars that the facet lacks (it lists at most 20, and new
// trims appear), then any value the profile has a state for, so it can be undone.
// "-" (MarketCheck's "no version") is dropped: those cars fall back to their trim.
// -> [{ value, count|null }]
export function facetChoices(facet, seen, kept) {
  const out = [];
  const seenKeys = {};
  const push = function (v, n) { const k = key(v); if (k && k !== "-" && !seenKeys[k]) { seenKeys[k] = true; out.push({ value: String(v).trim(), count: n }); } };
  const counts = (facet && facet.counts) || null;
  if (counts) Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); }).forEach(function (v) { push(v, counts[v]); });
  (seen || []).slice().sort().forEach(function (v) { push(v, null); });
  (kept || []).forEach(function (v) { push(v, counts ? 0 : null); });
  return out;
}

// The old text filters as chip states over the known trims: an exclude term hides
// every trim containing it; an include list hides every trim matching none of it;
// a preferred-trims term stars the trims containing it.
// -> { preferTrims, excludeTrims, trims, trimInclude: "", trimExclude: "" } | null (nothing to convert)
export function legacyTrimChips(params, values) {
  const p = params || {};
  const exc = terms(p.trimExclude), inc = terms(p.trimInclude);
  const prefTerms = (p.preferTrims && p.preferTrims.length) ? [] : terms(p.trims);
  if (!exc.length && !inc.length && !prefTerms.length) return null;
  const vals = values || [];
  const hit = function (v, list) { const t = key(v); return list.some(function (e) { return t.indexOf(e) > -1; }); };
  let exclude = (p.excludeTrims || []).slice();
  let prefer = (p.preferTrims || []).slice();
  vals.forEach(function (v) {
    if (has(exclude, v) || has(prefer, v)) return;
    if (hit(v, exc) || (inc.length && !hit(v, inc))) exclude.push(v);
    else if (prefTerms.length && hit(v, prefTerms)) prefer.push(v);
  });
  return { preferTrims: prefer, excludeTrims: exclude, trims: prefer.length ? prefer.join(", ") : (p.trims || ""), trimInclude: "", trimExclude: "" };
}
