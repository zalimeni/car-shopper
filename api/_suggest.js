// Prompt + schema for the profile wizard's optional AI step (api/profile-suggest.js):
// given a make / model / years / powertrain and what the live market looks like
// (trims with counts, price + mileage spread), suggest the profile's scoring
// fields and years worth skipping. The user edits everything; nothing is applied
// on its own. Pure, so it's unit-tested.

export const SUGGEST_SYSTEM =
  "You help a used-car shopper set up a search profile. Given the vehicle and a snapshot of the current nationwide " +
  "used market for it, suggest short, concrete criteria an AI scorer can check against a single dealer listing: " +
  "must-haves, nice-to-haves and dealbreakers (each a comma-separated list of brief phrases, not sentences), model " +
  "years to avoid with the reason (known reliability problems, recalls not remedied on every car, a generation " +
  "change that makes earlier years a poor buy), and short notes on the trims that matter. Be specific to this " +
  "vehicle and these years — no generic advice like \"clean title\" unless it is unusually relevant. Prefer things " +
  "visible in a listing (features, trim, warranty, CPO, recall work done). If you are unsure about a fact, leave it out.";

export function buildSuggestSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["mustHave", "niceToHave", "dealbreakers", "avoidYears", "trimNotes", "summary"],
    properties: {
      mustHave: { type: "string", description: "Comma-separated brief phrases" },
      niceToHave: { type: "string", description: "Comma-separated brief phrases" },
      dealbreakers: { type: "string", description: "Comma-separated brief phrases" },
      avoidYears: { type: "array", items: { type: "object", additionalProperties: false, required: ["year", "reason"],
        properties: { year: { type: "integer" }, reason: { type: "string" } } } },
      trimNotes: { type: "array", items: { type: "object", additionalProperties: false, required: ["trim", "note"],
        properties: { trim: { type: "string" }, note: { type: "string" } } } },
      summary: { type: "string", description: "One or two sentences on what to look for" },
    },
  };
}

const money = function (n) { return n != null && isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "?"; };
const num = function (n) { return n != null && isFinite(n) ? Math.round(n).toLocaleString("en-US") : "?"; };

export function buildSuggestPrompt(profile, market) {
  const p = (profile && profile.params) || {};
  const m = market || {};
  const lines = [
    "Vehicle: " + [p.make, p.model].filter(Boolean).join(" ") + (p.powertrain ? " (" + p.powertrain + ")" : ""),
    "Years: " + (p.years || "any"),
  ];
  if (m.count != null) lines.push("Used listings nationwide right now: " + num(m.count));
  const top = function (f) {
    const c = (f && f.counts) || {};
    return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).slice(0, 20).map(function (k) { return k + " (" + num(c[k]) + ")"; }).join(", ");
  };
  if (m.trims && m.trims.counts) lines.push("Trims listed: " + top(m.trims));
  if (m.years && m.years.counts) lines.push("By year: " + top(m.years));
  const st = m.stats || {};
  if (st.price) lines.push("Asking price: median " + money(st.price.median) + ", middle half " + money((st.price.percentiles || {})["25.0"]) + "–" + money((st.price.percentiles || {})["75.0"]));
  if (st.miles) lines.push("Mileage: median " + num(st.miles.median) + " mi");
  if (m.homeBase) lines.push("Buyer is based in: " + m.homeBase);
  return lines.join("\n") + "\n\nSuggest the profile's must-haves, nice-to-haves, dealbreakers, years to avoid and trim notes.";
}

// Keep only well-formed pieces of a model answer.
export function coerceSuggestion(x) {
  const o = x && typeof x === "object" ? x : {};
  const str = function (v) { return typeof v === "string" ? v.trim().slice(0, 600) : ""; };
  return {
    mustHave: str(o.mustHave), niceToHave: str(o.niceToHave), dealbreakers: str(o.dealbreakers), summary: str(o.summary),
    avoidYears: (Array.isArray(o.avoidYears) ? o.avoidYears : []).filter(function (a) { return a && Number.isInteger(a.year) && a.year > 1900; })
      .map(function (a) { return { year: a.year, reason: str(a.reason) }; }).slice(0, 10),
    trimNotes: (Array.isArray(o.trimNotes) ? o.trimNotes : []).filter(function (t) { return t && str(t.trim); })
      .map(function (t) { return { trim: str(t.trim), note: str(t.note) }; }).slice(0, 12),
  };
}
