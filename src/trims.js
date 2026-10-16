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
// (These replaced fuzzy trimInclude/trimExclude text; migrate v9 dropped it.)

const key = function (s) { return String(s == null ? "" : s).trim().toLowerCase(); };
const has = function (list, v) { const k = key(v); return !!k && (list || []).some(function (x) { return key(x) === k; }); };

// Why the profile's trim/drivetrain chips hide this listing, or null.
// -> { kind: "trim" | "drivetrain", text } | null
export function trimHideReason(l, params) {
  const p = params || {};
  if (l && l.trim && has(p.excludeTrims, l.trim)) return { kind: "trim", text: "hidden trim: " + l.trim };
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
