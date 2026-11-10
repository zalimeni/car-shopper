// Shared plumbing for api/ai.js: the caller's Anthropic key and the one-shot
// JSON / text calls every AI task makes.
//
// The key lives encrypted in the server-only vault (see api/_crypto.js and
// api/_supabaseAdmin.js) and is decrypted only here, per request.

import Anthropic from "@anthropic-ai/sdk";
import { decrypt } from "./_crypto.js";
import { getKeyRow, setKeyValid } from "./_supabaseAdmin.js";

// The caller's decrypted Anthropic key, or the error response to send.
// -> { apiKey } | { status, body }
// A key that no longer decrypts (KEY_ENCRYPTION_SECRET rotated) is marked
// invalid so the UI asks for a fresh one.
export async function loadAnthropicKey(userId) {
  const row = await getKeyRow(userId);
  if (!row) return { status: 400, body: { error: "no_key", message: "No Anthropic key on file — add one to use AI features" } };
  try {
    return { apiKey: decrypt(row.ciphertext) };
  } catch (e) {
    await setKeyValid(userId, false);
    return { status: 400, body: { error: "key_unreadable", message: "Stored key couldn't be decrypted — re-enter it" } };
  }
}

export function isAuthError(e) {
  return e instanceof Anthropic.AuthenticationError || !!(e && e.status === 401);
}

// Anthropic rejected the key: mark it invalid and say so (the UI prompts for a
// fresh key on this code).
export async function rejectKey(userId, res) {
  await setKeyValid(userId, false);
  res.status(401).json({ error: "key_rejected", message: "Anthropic rejected your key — re-enter it" });
}

// One streamed call (so a slow response can't trip an HTTP read timeout;
// .finalMessage() assembles it). -> { text } | { fail: "refused" | "truncated" }
// opts.allowTruncated: return the text even when it hit max_tokens (a prose
// answer that ran long is still usable; a JSON one is not).
export async function callText(client, params, opts) {
  const resp = await client.messages.stream(params).finalMessage();
  if (resp.stop_reason === "refusal") return { fail: "refused" };
  if (resp.stop_reason === "max_tokens" && !(opts && opts.allowTruncated)) return { fail: "truncated" };
  // With output_config.format the JSON lands in the (single) text block.
  const text = (resp.content || [])
    .filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; })
    .join("");
  return { text: text };
}

export function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

export function errMsg(e, fallback) {
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit — try again shortly";
  if (e && e.message) return String(e.message).slice(0, 200);
  return fallback || "AI request failed";
}
