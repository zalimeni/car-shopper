// Pure helpers for AI scoring — prompt + JSON-schema construction and response
// coercion. Kept separate from the request handler so they're unit-testable
// without hitting Anthropic.
//
// The app's criteria are user-editable, so the schema and the rubric are built
// from whatever criteria the client sends rather than hardcoded.

// Models the user may pick for scoring (allowlisted so a request can't drive
// arbitrary model strings). Default is Sonnet — strong judgment for this
// structured task at a lower cost than Opus. SCORING_MODEL env var, when set to
// one of these, overrides the default; the per-request model (from the UI) wins
// over both when it's in this list.
export const SCORE_MODELS = {
  "claude-sonnet-5": "Sonnet 5 — balanced (recommended)",
  "claude-opus-4-8": "Opus 4.8 — most nuanced",
  "claude-haiku-4-5": "Haiku 4.5 — fastest / cheapest",
};

export const DEFAULT_SCORE_MODEL =
  process.env.SCORING_MODEL && Object.prototype.hasOwnProperty.call(SCORE_MODELS, process.env.SCORING_MODEL)
    ? process.env.SCORING_MODEL
    : "claude-sonnet-5";

export function resolveScoreModel(requested) {
  if (requested && Object.prototype.hasOwnProperty.call(SCORE_MODELS, requested)) return requested;
  return DEFAULT_SCORE_MODEL;
}

// Per-criterion guidance baked into the rubric so 1-10 means the same thing
// across runs. Keyed by the default criterion ids; criteria without an entry
// (e.g. user-added) still get scored, just without extra guidance.
export const CRITERION_GUIDANCE = {
  price: "10 = well under the profile's price ceiling and under market for THAT trim/mileage; 1 = at or over ceiling / overpriced for the market. Judge against what the listing's own trim should cost — a higher trim at a lower-trim price is a bargain, not an overspend.",
  mileage: "10 = low miles for the model year (well under ~12k/yr); 1 = high miles for its age.",
  dealer: "10 = CPO or reputable franchise; 5 = independent; 1 = private/unknown or red flags.",
  condition: "10 = clean title, 1-owner, no accidents, well-maintained; 1 = branded title, accidents, or neglect.",
  features: "10 = target trim or richer with all must-have + several nice-to-have features (a trim above the buyer's preferred level is a bonus, never a penalty); 1 = a trim below their preferred level / missing must-haves.",
  color: "10 = preferred/neutral color; 1 = a color the buyer wants to avoid (see requirements).",
  location: "10 = local & low salt-belt exposure; 1 = far away and/or heavy road-salt region (rust risk).",
  deal: "10 = priced well below comparable listings (great deal); 1 = priced above market.",
};

// JSON schema for one listing's scores. enum 1..10 constrains each score to an
// integer in range (Structured Outputs supports enum but not min/max). All
// criteria are required, plus a free-text overall summary.
export function buildScoreSchema(criteria) {
  const critProps = {};
  const critRequired = [];
  (criteria || []).forEach(function (c) {
    critProps[c.id] = {
      type: "object",
      properties: {
        score: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        rationale: { type: "string" },
      },
      required: ["score", "rationale"],
      additionalProperties: false,
    };
    critRequired.push(c.id);
  });
  return {
    type: "object",
    properties: {
      criteria: {
        type: "object",
        properties: critProps,
        required: critRequired,
        additionalProperties: false,
      },
      summary: { type: "string" },
    },
    required: ["criteria", "summary"],
    additionalProperties: false,
  };
}

export const SCORE_SYSTEM =
  "You are an expert used-car buyer's assistant. You evaluate a single used-car " +
  "listing against a buyer's specific shopping profile and weighted scoring " +
  "criteria, and return a calibrated 1-10 score for each criterion with a short, " +
  "concrete rationale grounded in the listing data — plus a 1-2 sentence overall " +
  "summary. Be decisive and specific; cite the actual numbers (price, mileage, " +
  "year). 10 is excellent, 5 is average, 1 is poor. If a fact isn't in the " +
  "listing data, say so rather than inventing it, and score conservatively. " +
  "Do not penalize, flag, or comment on missing/unstated title or ownership " +
  "history — absence of a Carfax confirmation is not a negative. Only an " +
  "explicitly reported branded/salvage/rebuilt title or accident is a concern. " +
  "Trim levels form a ladder. The buyer's listed trims are a preferred floor, not " +
  "an exclusive whitelist: a trim ABOVE them (more standard equipment — e.g. " +
  "Limited or Touring above LE or Premium) fully satisfies the trim preference and " +
  "must never be marked down as the \"wrong trim\". At a comparable price a richer " +
  "trim is strictly better — more car for the money — so it should score higher, " +
  "not lower. Only a trim BELOW the buyer's preferred level, or one they explicitly " +
  "excluded, counts against a listing.";

// Compact, deterministic listing serialization for the prompt — only fields that
// are present. Includes Carfax / pricing extras when the listing carries them.
function listingFacts(l) {
  const f = [];
  const add = function (label, v) { if (v !== undefined && v !== null && v !== "") f.push(label + ": " + v); };
  add("Year", l.year);
  add("Vehicle", l.vehicle);
  add("Trim", l.trim);
  add("Price", l.price != null ? "$" + Number(l.price).toLocaleString() : null);
  // Only surface MSRP when it's a real original-sticker signal (> asking price);
  // on used inventory MarketCheck's msrp often just echoes price.
  add("MSRP", l.msrp != null && l.price != null && Number(l.msrp) > Number(l.price) ? "$" + Number(l.msrp).toLocaleString() : null);
  add("Price change since first seen", l.price_change_percent != null ? l.price_change_percent + "%" : null);
  add("Mileage", l.mileage != null ? Number(l.mileage).toLocaleString() + " mi" : null);
  add("Dealer", l.dealer);
  add("Dealer type", l.dealerType);
  // CPO is a strong positive — manufacturer-backed inspection + extended
  // warranty. Surface it explicitly (l.dealerType === "CPO" handles listings
  // synced before cpo became its own field).
  if (l.cpo === true || l.dealerType === "CPO") f.push("Certified Pre-Owned (CPO): Yes — manufacturer-backed inspection & extended warranty");
  add("Location", [l.location, l.state].filter(Boolean).join(", "));
  add("Distance from buyer's search location", l.distMi != null ? l.distMi + " mi" : null);
  add("Color", l.color);
  add("Days on market", l.dom);
  // Recent asking-price trajectory — a strong deal/negotiation signal.
  if (Array.isArray(l.priceHistory) && l.priceHistory.length >= 2) {
    const pts = l.priceHistory.slice(-5).map(function (h) {
      return "$" + Number(h.price).toLocaleString() + (h.date ? " (" + h.date + ")" : "");
    });
    f.push("Asking-price history: " + pts.join(" → "));
  }
  add("Deal rating", l.dealRating);
  // Only surface CONFIRMED Carfax positives. A false here just means "not stated
  // on the dealer site" (the common case), not a negative finding — feeding it to
  // the model only makes it harp on an unverified title. The UI shows an
  // unconfirmed-title note to the human instead; it is not a scoring input.
  if (l.carfax_1_owner === true) f.push("Carfax: 1-owner confirmed");
  if (l.carfax_clean_title === true) f.push("Carfax: clean title confirmed");
  add("Notes", l.notes);
  return f.join("\n");
}

function profileFacts(p) {
  if (!p || !p.params) return "(no profile detail provided)";
  const x = p.params;
  const f = [];
  const add = function (label, v) { if (v !== undefined && v !== null && v !== "") f.push(label + ": " + v); };
  add("Looking for", [p.name, x.make, x.model].filter(Boolean).join(" "));
  add("Powertrain", x.powertrain);
  add("Acceptable years", x.years);
  add("Preferred trims", x.trims);
  // Spelled out because a bare trim list reads as a whitelist, and the model was
  // marking richer trims down as "wrong trim" instead of treating them as upside.
  if (x.trims) f.push("Trim handling: the preferred trims are a floor, not a whitelist — a higher/richer trim also qualifies and is a plus at a comparable price; only a trim below them counts against the listing.");
  add("Max price", x.maxPrice != null ? "$" + Number(x.maxPrice).toLocaleString() : null);
  add("Max mileage", x.maxMiles != null ? Number(x.maxMiles).toLocaleString() + " mi" : null);
  add("Must have", x.mustHave);
  add("Nice to have", x.niceToHave);
  add("Dealbreakers", x.dealbreakers);
  return f.join("\n");
}

// ── Price baseline (per year-range × trim anchors, mileage-adjusted) ──
function yearInRange(str, y) {
  if (!str || y == null) return false;
  return String(str).split(",").some(function (part) {
    const t = part.trim();
    const m = t.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) { const tmp = a; a = b; b = tmp; } return y >= a && y <= b; }
    return String(y) === t;
  });
}
// Good/fair/high asking-price bands for a listing (matched tier by year+trim,
// then adjusted by the per-1000-mile slope). Returns null when no baseline.
export function resolveBaselineBands(baseline, year, trim, mileage) {
  if (!baseline) return null;
  const t = String(trim || "").toLowerCase();
  const tier = (baseline.tiers || []).find(function (x) {
    return yearInRange(x.years, year) && (!x.trim || t.indexOf(String(x.trim).toLowerCase()) > -1);
  });
  const band = tier || baseline.default;
  if (!band || band.good == null) return null;
  let good = Number(band.good), fair = Number(band.fair), high = Number(band.high);
  const per = Number(baseline.perThousandMi) || 0, ref = Number(baseline.refMileage) || 0;
  if (per && ref && mileage != null) {
    const adj = ((Number(mileage) - ref) / 1000) * per; // more miles → lower fair price
    good = Math.round(good - adj); fair = Math.round(fair - adj); high = Math.round(high - adj);
  }
  return { good: good, fair: fair, high: high, matchedTier: !!tier };
}

// Schema + prompt for AI baseline generation, grounded in the user's real listings.
export function buildBaselineSchema() {
  const tier = {
    type: "object",
    properties: { years: { type: "string" }, trim: { type: "string" }, good: { type: "integer" }, fair: { type: "integer" }, high: { type: "integer" } },
    required: ["years", "trim", "good", "fair", "high"], additionalProperties: false,
  };
  const band = { type: "object", properties: { good: { type: "integer" }, fair: { type: "integer" }, high: { type: "integer" } }, required: ["good", "fair", "high"], additionalProperties: false };
  return {
    type: "object",
    properties: { refMileage: { type: "integer" }, perThousandMi: { type: "integer" }, tiers: { type: "array", items: tier }, default: band },
    required: ["refMileage", "perThousandMi", "tiers", "default"], additionalProperties: false,
  };
}

export const BASELINE_SYSTEM =
  "You are a used-car pricing analyst. Given a buyer's target vehicle and a sample of real recent local dealer listings, produce asking-price baselines a shopper can score against. For each relevant model year and trim, give a good (great-deal), fair (typical market), and high (overpriced) asking price, all quoted at one sensible reference mileage, plus perThousandMi = how much the fair price drops per 1,000 miles above that reference. Group consecutive years that share the same generation/pricing into a range (e.g. \"2019-2020\"). Cover the buyer's years and trims of interest, and also give tiers for trims ABOVE their preferred level that show up in this market — otherwise a richer trim gets priced against a lower trim's band and looks overpriced. Ground the numbers in the provided real listings where available; use general market knowledge to fill gaps. All prices in whole US dollars.";

export function buildBaselinePrompt(profile, listings) {
  const p = (profile && profile.params) || {};
  const rows = (listings || []).slice(0, 60).map(function (l) {
    return "- " + (l.year || "?") + " " + (l.trim || "") + " · " + (l.mileage != null ? Number(l.mileage).toLocaleString() + " mi" : "? mi") + " · " + (l.price != null ? "$" + Number(l.price).toLocaleString() : "?");
  });
  return [
    "TARGET VEHICLE: " + [profile && profile.name, p.make, p.model, p.powertrain].filter(Boolean).join(" "),
    "Years of interest: " + (p.years || "any") + " · Trims: " + (p.trims || "any") + " · Budget ceiling: " + (p.maxPrice ? "$" + Number(p.maxPrice).toLocaleString() : "n/a"),
    "",
    "REAL LOCAL LISTINGS (" + (listings ? listings.length : 0) + " sampled" + (listings && listings.length > 60 ? ", showing 60" : "") + "):",
    rows.length ? rows.join("\n") : "(none available — use general market knowledge for this model/region)",
    "",
    "Produce good/fair/high asking-price baselines per (year-range, trim) at a sensible reference mileage, plus the per-1,000-mile adjustment.",
  ].join("\n");
}

export function buildUserPrompt(listing, ctx) {
  ctx = ctx || {};
  const criteria = ctx.criteria || [];
  const reqs = (ctx.globalReqs || []).filter(function (r) { return r.active; }).map(function (r) { return "- " + r.text; });

  const rubric = criteria.map(function (c) {
    // Per-criterion guidance the user can override (Criteria tab) — falls back
    // to the built-in default, then a generic line.
    const g = (typeof c.guidance === "string" && c.guidance.trim()) ? c.guidance.trim() : CRITERION_GUIDANCE[c.id];
    return "- " + c.id + " (\"" + c.name + "\", weight " + c.weight + "): " + (g || "Score how well the listing satisfies this criterion.");
  });

  // If the profile carries a price baseline, compute this listing's concrete
  // good/fair/high bands and hand them to the model to anchor the price score.
  const baseline = ctx.profile && ctx.profile.params && ctx.profile.params.priceBaseline;
  const bands = baseline ? resolveBaselineBands(baseline, listing.year, listing.trim, listing.mileage) : null;
  const baselineSection = bands
    ? "PRICE BASELINE FOR THIS LISTING (" + (listing.year || "?") + " " + (listing.trim || "") + " @ " + (listing.mileage != null ? Number(listing.mileage).toLocaleString() + " mi" : "? mi") + "): good ≤ $" + bands.good.toLocaleString() + " · fair ≈ $" + bands.fair.toLocaleString() + " · high ≥ $" + bands.high.toLocaleString() + ". For the \"price\" criterion, anchor on these: 9-10 at/below good, ~5 near fair, 1-2 at/above high; interpolate between."
      // Without a tier for this listing's own trim the numbers are a generic
      // fallback — usually calibrated to a lower trim, which would otherwise
      // score a richer trim as "overpriced" purely for being a richer trim.
      + (bands.matchedTier ? "" : " NOTE: no baseline tier matches this listing's trim, so these are generic fallback numbers. If this trim sits above the buyer's preferred trims it should legitimately price above these bands — treat them as a floor, not a ceiling, and do not mark the listing down for clearing them on trim alone.")
    : "";

  return [
    "BUYER PROFILE:",
    profileFacts(ctx.profile),
    "",
    "HARD REQUIREMENTS / PREFERENCES (apply to condition, color, etc.):",
    reqs.length ? reqs.join("\n") : "(none)",
    baselineSection ? "\n" + baselineSection : "",
    "",
    "SCORING CRITERIA (score each 1-10):",
    rubric.join("\n"),
    "",
    "LISTING TO EVALUATE:",
    listingFacts(listing),
    "",
    "Return a score (1-10) and one-sentence rationale for every criterion id " +
      "listed above, plus a 1-2 sentence overall summary of this listing as a buy.",
  ].join("\n");
}

// Validate + clamp a parsed model response into { scores, rationales, summary }.
// Returns null when a required criterion is missing (caller marks the listing
// failed) — we don't fabricate scores for absent criteria.
export function coerceResult(parsed, criteria) {
  if (!parsed || typeof parsed !== "object" || !parsed.criteria) return null;
  const scores = {};
  const rationales = {};
  for (let i = 0; i < criteria.length; i++) {
    const id = criteria[i].id;
    const entry = parsed.criteria[id];
    if (!entry || typeof entry.score !== "number") return null;
    let s = Math.round(entry.score);
    if (s < 1) s = 1;
    if (s > 10) s = 10;
    scores[id] = s;
    if (typeof entry.rationale === "string") rationales[id] = entry.rationale.trim();
  }
  return {
    scores: scores,
    rationales: rationales,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
  };
}
