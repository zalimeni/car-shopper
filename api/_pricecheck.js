// Prompt for the Price Check tool's AI fair-price verdict (task "price" of
// api/ai.js). Pure, so it's testable without calling Anthropic.
//
// Given the shopper's target vehicle + the comparable listings they've observed
// (from their own tracked/rejected data, plus any live-market comps), the model
// returns a concise plain-English take on whether the asking price is fair.

// Fixed fast model with up-front thinking off — a one-shot verdict, like
// the baseline task. Sonnet 5.5 rejects thinking:{type:"disabled"}; "between_tools"
// is its lowest setting.
export const PRICE_MODEL = "claude-sonnet-5-5";

export const PRICE_SYSTEM =
  "You are a sharp, concise used-car pricing analyst helping a private buyer decide whether an asking price is fair. " +
  "Answer in 2–4 sentences, direct and practical, no preamble. Lead with a clear verdict (e.g. fair / a bit high / great deal). " +
  "Ground it in the comparable listings and stats provided — cite rough numbers. If the comp sample is thin or the mileages/trims " +
  "differ a lot, say so and hedge accordingly. A confidence signal (from comp count and price spread) is provided — weight your " +
  "certainty to match it: be decisive on high confidence, and on low confidence explicitly flag that this is a rough read. " +
  "Remember these are asking prices, not sale prices.";

function money(n) { return "$" + Number(n || 0).toLocaleString(); }

function confidenceLine(conf, comps) {
  if (!conf || !conf.level || conf.level === "none") return "";
  const live = (comps || []).filter(function (c) { return c && c.live; }).length;
  const spread = conf.relIqr != null ? ", price spread ±" + Math.round(conf.relIqr * 100) + "% around the median" : "";
  const mix = live ? " (" + live + " from a live-market search, the rest your own tracked data)" : "";
  return "CONFIDENCE: " + conf.level.toUpperCase() + " — based on " + (conf.n || 0) + " comp"
    + ((conf.n || 0) === 1 ? "" : "s") + mix + spread + ".";
}

export function buildPricePrompt(q, comps, stats, conf) {
  const lines = [];
  lines.push("VEHICLE BEING PRICED:");
  lines.push(
    [q.year, q.make, q.model, q.trim].filter(Boolean).join(" ")
    + (q.mileage ? " · " + Number(q.mileage).toLocaleString() + " mi" : "")
    + (q.askingPrice ? " · asking " + money(q.askingPrice) : " · (no asking price given)")
  );
  const confLine = confidenceLine(conf, comps);
  if (confLine) { lines.push(""); lines.push(confLine); }
  if (stats && stats.n) {
    lines.push("");
    lines.push("COMP STATS (" + stats.n + " comparable listing" + (stats.n === 1 ? "" : "s") + "): "
      + "median " + money(stats.median) + ", typical " + money(stats.p25) + "–" + money(stats.p75)
      + ", full range " + money(stats.min) + "–" + money(stats.max) + ".");
  }
  if (comps && comps.length) {
    lines.push("");
    lines.push("COMPARABLE LISTINGS (year · trim · mileage · price · source):");
    comps.slice(0, 12).forEach(function (c) {
      lines.push("- " + [
        c.year || "?",
        c.trim || "?",
        (c.mileage != null ? Number(c.mileage).toLocaleString() + " mi" : "? mi"),
        money(c.price),
        c.live ? "live market" : (c.status || "your data"),
      ].join(" · ") + (c.cpo ? " (CPO)" : ""));
    });
  } else {
    lines.push("");
    lines.push("(No local comparable listings — rely on general market knowledge and call out the lack of local comps.)");
  }
  lines.push("");
  lines.push("Is the asking price fair? Give a direct verdict and the key reasons.");
  return lines.join("\n");
}

