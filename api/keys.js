// Per-user API key management: the Anthropic key and the MarketCheck keys.
//
//   GET                                   — metadata only:
//        { anthropic: { configured, valid, last4 }, marketcheck: [{ id, label, last4, position, valid }] }
//   POST   { key }                         — Anthropic: validate against Anthropic, then store
//   POST   { provider: "marketcheck", key, label? }   — add one MarketCheck key (appended)
//   POST   { provider: "marketcheck", import: [{ key, label }] } — move keys from an
//                                            old app-state blob into the vault (skips duplicates)
//   PATCH  { provider: "marketcheck", id, label } and/or { order: [id, …] }
//   DELETE { provider?: "anthropic" }      — remove the Anthropic key
//   DELETE { provider: "marketcheck", id } — remove one MarketCheck key
//
// Every write answers with the full metadata (same shape as GET). Plaintext keys
// never leave this request: they're validated, encrypted (api/_crypto.js) and
// written to the server-only vault (api/_keys.js). The browser only ever learns
// labels, the last 4 characters, and whether a key works.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { cryptoReady } from "./_crypto.js";
import { keyMeta, setAnthropicKey, deleteAnthropicKey, addMarketcheckKeys, updateMarketcheckKeys, deleteMarketcheckKey, looksLikeMarketcheckKey } from "./_keys.js";

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  const userId = auth.user.id;

  if (req.method === "GET") { res.status(200).json(await keyMeta(userId)); return; }
  if (["POST", "PATCH", "DELETE"].indexOf(req.method) < 0) { res.status(405).json({ error: "Use GET, POST, PATCH, or DELETE" }); return; }
  if (!cryptoReady()) { res.status(500).json({ error: "Key encryption is not configured on the server (KEY_ENCRYPTION_SECRET)" }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const provider = body.provider === "marketcheck" ? "marketcheck" : "anthropic";
  const done = async function (r) {
    if (r && r.error) { res.status(502).json({ error: "The server couldn't update the Supabase key vault: " + r.error + " (check SUPABASE_SECRET_KEY)" }); return; }
    res.status(200).json(await keyMeta(userId));
  };

  if (provider === "marketcheck") {
    if (req.method === "DELETE") { await done(await deleteMarketcheckKey(userId, body.id)); return; }
    if (req.method === "PATCH") { await done(await updateMarketcheckKeys(userId, { id: body.id, label: body.label, order: body.order })); return; }
    const list = Array.isArray(body.import) ? body.import : [{ key: body.key, label: body.label }];
    const clean = list.map(function (e) { return { key: String((e && e.key) || "").trim(), label: (e && e.label) || "" }; }).filter(function (e) { return e.key; });
    if (!clean.length) { res.status(400).json({ error: "Missing 'key'" }); return; }
    if (!Array.isArray(body.import) && !looksLikeMarketcheckKey(clean[0].key)) {
      res.status(400).json({ error: "That doesn't look like a MarketCheck API key (letters and digits, 16+ characters)" });
      return;
    }
    await done(await addMarketcheckKeys(userId, clean));
    return;
  }

  // ── Anthropic ──
  if (req.method === "DELETE") { await done(await deleteAnthropicKey(userId)); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST or DELETE for the Anthropic key" }); return; }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) { res.status(400).json({ error: "Missing 'key'" }); return; }
  if (key.indexOf("sk-ant-") !== 0) {
    res.status(400).json({ error: "That doesn't look like an Anthropic API key (expected to start with 'sk-ant-')" });
    return;
  }
  // Validate cheaply with a GET (models.list) — 401 if the key is bad, and it
  // spends no tokens.
  try {
    const client = new Anthropic({ apiKey: key });
    await client.models.list();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || (e && e.status === 401)) {
      res.status(401).json({ error: "Anthropic rejected that key" });
      return;
    }
    res.status(502).json({ error: "Couldn't reach Anthropic to validate the key — try again" });
    return;
  }
  await done(await setAnthropicKey(userId, key));
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
