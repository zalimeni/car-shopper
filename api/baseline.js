// AI-assisted price-baseline generation for a profile, using the caller's key.
//
// POST { profile, listings:[{year,trim,price,mileage}], model? }
//   -> { baseline: { refMileage, perThousandMi, tiers:[{years,trim,good,fair,high}], default } }
//
// The model is grounded in the user's own real synced listings for the profile
// (passed in `listings`) plus general market knowledge. Same key/vault/model
// plumbing as /api/score.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { decrypt, cryptoReady } from "./_crypto.js";
import { getKeyRow, setKeyValid } from "./_supabaseAdmin.js";
import { resolveScoreModel, BASELINE_SYSTEM, buildBaselineSchema, buildBaselinePrompt } from "./_scoring.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  if (auth.user.debug) { res.status(400).json({ error: "Requires a real signed-in account" }); return; }
  if (!cryptoReady()) { res.status(500).json({ error: "Key encryption is not configured on the server" }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const profile = body.profile || {};
  if (!profile.params || !profile.params.make || !profile.params.model) {
    res.status(400).json({ error: "Profile needs a make and model" });
    return;
  }

  const row = await getKeyRow(auth.user.id);
  if (!row) { res.status(400).json({ error: "no_key", message: "No Anthropic key on file — add one first" }); return; }
  let apiKey;
  try { apiKey = decrypt(row.ciphertext); }
  catch (e) { await setKeyValid(auth.user.id, false); res.status(400).json({ error: "key_unreadable", message: "Stored key couldn't be decrypted — re-enter it" }); return; }

  const client = new Anthropic({ apiKey: apiKey });
  const model = resolveScoreModel(body.model);
  const listings = Array.isArray(body.listings) ? body.listings : [];

  try {
    const resp = await client.messages.create({
      model: model,
      max_tokens: 8000, // Claude 5 models always think — leave room before the JSON
      system: BASELINE_SYSTEM,
      messages: [{ role: "user", content: buildBaselinePrompt(profile, listings) }],
      output_config: { format: { type: "json_schema", schema: buildBaselineSchema() } },
    });
    if (resp.stop_reason === "refusal") { res.status(502).json({ error: "The model declined this request" }); return; }
    if (resp.stop_reason === "max_tokens") { res.status(502).json({ error: "Model output hit the token limit — try again" }); return; }
    const text = (resp.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
    const parsed = safeParse(text);
    if (!parsed || !Array.isArray(parsed.tiers)) { res.status(502).json({ error: "Couldn't parse the generated baseline" }); return; }
    res.status(200).json({ baseline: parsed });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || (e && e.status === 401)) {
      await setKeyValid(auth.user.id, false);
      res.status(401).json({ error: "key_rejected", message: "Anthropic rejected your key — re-enter it" });
      return;
    }
    res.status(502).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : "Baseline generation failed" });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
