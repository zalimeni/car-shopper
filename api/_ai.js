// Shared plumbing for api/ai.js: the caller's Anthropic key and the one-shot
// JSON / text calls every AI task makes.
//
// The key lives encrypted in the server-only vault (public.user_api_keys);
// api/_keys.js is the only module that decrypts it.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicKey, setAnthropicValid } from "./_keys.js";

// The caller's decrypted Anthropic key, or the error response to send.
// -> { apiKey } | { status, body }
// getAnthropicKey marks a key that no longer decrypts as invalid, so the UI
// asks for a fresh one.
export async function loadAnthropicKey(userId) {
  const k = await getAnthropicKey(userId);
  if (k.error) return { status: k.error === "not_configured" ? 500 : 400, body: { error: k.error, message: k.message } };
  return { apiKey: k.key };
}

export function isAuthError(e) {
  return e instanceof Anthropic.AuthenticationError || !!(e && e.status === 401);
}

// Anthropic rejected the key: mark it invalid and say so (the UI prompts for a
// fresh key on this code).
export async function rejectKey(userId, res) {
  await setAnthropicValid(userId, false);
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
