// Symmetric encryption for the per-user Anthropic API key at rest.
//
// The user's key is stored encrypted in public.user_anthropic_keys and is only
// ever decrypted server-side, in the /api/score request path, to call Anthropic
// on the user's behalf. It is never returned to the client (write-only — the UI
// shows status + last 4 only).
//
// AES-256-GCM with a 32-byte key derived (SHA-256) from KEY_ENCRYPTION_SECRET,
// a server-only secret. The stored blob is base64(iv ‖ authTag ‖ ciphertext);
// GCM's tag makes tampering/decryption-with-a-rotated-secret fail loudly rather
// than yield garbage. Rotating the secret invalidates stored keys (they fail to
// decrypt → marked invalid → user re-enters), which is the safe default.

import crypto from "node:crypto";

const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

function key() {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("KEY_ENCRYPTION_SECRET is not configured on the server");
  }
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decrypt(blob) {
  const buf = Buffer.from(String(blob), "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// True if encryption is usable (secret configured). Lets endpoints return a
// clear "not configured" error instead of throwing mid-request.
export function cryptoReady() {
  try { key(); return true; } catch (e) { return false; }
}
