// The profile wizard's optional AI step, using the caller's own Anthropic key.
//
// POST { profile, market: { count, trims, years, stats, homeBase }, model? }
//   -> { suggestion: { mustHave, niceToHave, dealbreakers, avoidYears:[{year,reason}], trimNotes:[{trim,note}], summary } }
//
// Same key/vault plumbing and model settings as /api/baseline (a one-shot JSON
// answer the user edits). Prompt + schema: api/_suggest.js.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { decrypt, cryptoReady } from "./_crypto.js";
import { getKeyRow, setKeyValid } from "./_supabaseAdmin.js";
import { SUGGEST_SYSTEM, buildSuggestSchema, buildSuggestPrompt, coerceSuggestion } from "./_suggest.js";

// As in api/baseline.js: Sonnet 5.5 with thinking at its lowest setting keeps the
// call well under the 60 s function limit.
const SUGGEST_MODEL = "claude-sonnet-5-5";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  if (auth.user.debug) { res.status(400).json({ error: "Requires a real signed-in account" }); return; }
  if (!cryptoReady()) { res.status(500).json({ error: "Key encryption is not configured on the server" }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const profile = body.profile || {};
  if (!profile.params || !profile.params.make || !profile.params.model) { res.status(400).json({ error: "Profile needs a make and model" }); return; }

  const row = await getKeyRow(auth.user.id);
  if (!row) { res.status(400).json({ error: "no_key", message: "No Anthropic key on file — add one first" }); return; }
  let apiKey;
  try { apiKey = decrypt(row.ciphertext); }
  catch (e) { await setKeyValid(auth.user.id, false); res.status(400).json({ error: "key_unreadable", message: "Stored key couldn't be decrypted — re-enter it" }); return; }

  const client = new Anthropic({ apiKey: apiKey });
  try {
    const resp = await client.messages.stream({
      model: SUGGEST_MODEL,
      max_tokens: 4000,
      thinking: { type: "between_tools" },
      system: SUGGEST_SYSTEM,
      messages: [{ role: "user", content: buildSuggestPrompt(profile, body.market) }],
      output_config: { format: { type: "json_schema", schema: buildSuggestSchema() } },
    }).finalMessage();
    if (resp.stop_reason === "refusal") { res.status(502).json({ error: "The model declined this request" }); return; }
    if (resp.stop_reason === "max_tokens") { res.status(502).json({ error: "Model output hit the token limit — try again" }); return; }
    const text = (resp.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
    const parsed = safeParse(text);
    if (!parsed) { res.status(502).json({ error: "Couldn't parse the suggestions" }); return; }
    res.status(200).json({ suggestion: coerceSuggestion(parsed) });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || (e && e.status === 401)) {
      await setKeyValid(auth.user.id, false);
      res.status(401).json({ error: "key_rejected", message: "Anthropic rejected your key — re-enter it" });
      return;
    }
    res.status(502).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : "Suggestion failed" });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
