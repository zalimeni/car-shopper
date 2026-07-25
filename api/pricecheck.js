// AI fair-price verdict for the Price Check tool, using the caller's own key.
//
// POST { query:{year,make,model,trim,mileage,askingPrice}, comps:[...], stats:{...} }
//   -> { assessment: "<a few sentences>" }
//
// Given the shopper's target vehicle + the comparable listings they've observed
// (from their own tracked/rejected data), returns a concise plain-English take
// on whether the asking price is fair. Same key/vault plumbing as /api/score.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { decrypt, cryptoReady } from "./_crypto.js";
import { getKeyRow, setKeyValid } from "./_supabaseAdmin.js";

// Fixed fast model (thinking disabled) — a one-shot verdict, like /api/baseline.
const MODEL = "claude-sonnet-4-6";

const SYSTEM =
  "You are a sharp, concise used-car pricing analyst helping a private buyer decide whether an asking price is fair. " +
  "Answer in 2–4 sentences, direct and practical, no preamble. Lead with a clear verdict (e.g. fair / a bit high / great deal). " +
  "Ground it in the comparable listings and stats provided — cite rough numbers. If the comp sample is thin or the mileages/trims " +
  "differ a lot, say so and hedge accordingly. A confidence signal (from comp count and price spread) is provided — weight your " +
  "certainty to match it: be decisive on high confidence, and on low confidence explicitly flag that this is a rough read. " +
  "Remember these are asking prices, not sale prices.";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  if (auth.user.debug) { res.status(400).json({ error: "Requires a real signed-in account" }); return; }
  if (!cryptoReady()) { res.status(500).json({ error: "Key encryption is not configured on the server" }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const q = body.query || {};
  if (!q.make && !q.model) { res.status(400).json({ error: "Need at least a make and model" }); return; }

  const row = await getKeyRow(auth.user.id);
  if (!row) { res.status(400).json({ error: "no_key", message: "No Anthropic key on file — add one first" }); return; }
  let apiKey;
  try { apiKey = decrypt(row.ciphertext); }
  catch (e) { await setKeyValid(auth.user.id, false); res.status(400).json({ error: "key_unreadable", message: "Stored key couldn't be decrypted — re-enter it" }); return; }

  const client = new Anthropic({ apiKey: apiKey });
  try {
    const resp = await client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(q, Array.isArray(body.comps) ? body.comps : [], body.stats || null, body.confidence || null) }],
    }).finalMessage();
    if (resp.stop_reason === "refusal") { res.status(502).json({ error: "The model declined this request" }); return; }
    const text = (resp.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("").trim();
    if (!text) { res.status(502).json({ error: "Empty response from the model" }); return; }
    res.status(200).json({ assessment: text });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || (e && e.status === 401)) {
      await setKeyValid(auth.user.id, false);
      res.status(401).json({ error: "key_rejected", message: "Anthropic rejected your key — re-enter it" });
      return;
    }
    res.status(502).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : "Assessment failed" });
  }
}

function money(n) { return "$" + Number(n || 0).toLocaleString(); }

function confidenceLine(conf, comps) {
  if (!conf || !conf.level || conf.level === "none") return "";
  const live = (comps || []).filter(function (c) { return c && c.live; }).length;
  const spread = conf.relIqr != null ? ", price spread ±" + Math.round(conf.relIqr * 100) + "% around the median" : "";
  const mix = live ? " (" + live + " from a live-market search, the rest your own tracked data)" : "";
  return "CONFIDENCE: " + conf.level.toUpperCase() + " — based on " + (conf.n || 0) + " comp"
    + ((conf.n || 0) === 1 ? "" : "s") + mix + spread + ".";
}

function buildPrompt(q, comps, stats, conf) {
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

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
