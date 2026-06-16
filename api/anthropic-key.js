// Per-user Anthropic API key management.
//
//   POST   { key }  — validate the key against Anthropic, then store it
//                     encrypted (write-only). Returns { ok, valid, last4 }.
//   DELETE          — remove the stored key.
//   GET             — status only: { configured, valid, last4 }.
//
// The plaintext key never leaves this request: it's validated, encrypted, and
// written to the server-only vault. The browser only ever learns the last 4
// digits and whether the key currently works. See api/_crypto.js and
// api/_supabaseAdmin.js for the storage/encryption boundary.

import Anthropic from "@anthropic-ai/sdk";
import { authorize } from "./_auth.js";
import { encrypt, cryptoReady } from "./_crypto.js";
import { upsertKey, deleteKey, getKeyStatus } from "./_supabaseAdmin.js";

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  // The debug bypass has no real auth.users row, so it can't own a vault entry.
  if (auth.user.debug) {
    res.status(400).json({ error: "Key storage requires a real signed-in account" });
    return;
  }
  const userId = auth.user.id;

  if (req.method === "GET") {
    const status = await getKeyStatus(userId);
    res.status(200).json(status);
    return;
  }

  if (req.method === "DELETE") {
    const r = await deleteKey(userId);
    if (r.error) { res.status(500).json({ error: r.error }); return; }
    res.status(200).json({ ok: true, configured: false, valid: false, last4: "" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use GET, POST, or DELETE" });
    return;
  }

  if (!cryptoReady()) {
    res.status(500).json({ error: "Key encryption is not configured on the server (KEY_ENCRYPTION_SECRET)" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
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

  const r = await upsertKey(userId, encrypt(key), key.slice(-4));
  if (r.error) { res.status(500).json({ error: r.error }); return; }
  res.status(200).json({ ok: true, configured: true, valid: true, last4: key.slice(-4) });
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
