// Symmetric encryption for the per-user API keys at rest (public.user_api_keys).
//
// A user's Anthropic and MarketCheck keys are stored encrypted and are only
// ever decrypted server-side, to call those APIs on the user's behalf. They are
// never returned to the client (write-only — the UI shows label + last 4 only).
//
// v2 (current): AES-256-GCM with a 32-byte key derived by HKDF-SHA256 from
// KEY_ENCRYPTION_SECRET, a server-only secret. The key row's owner and provider
// ("<user_id>:<provider>") are bound in as additional authenticated data, so a
// ciphertext copied into another user's row (or another provider's) fails to
// decrypt. Stored as "v2:" + base64(iv ‖ authTag ‖ ciphertext).
//
// v1 (legacy, read-only): no prefix, key = SHA-256(secret), no AAD. Rows still
// in v1 are re-encrypted to v2 when they are read (api/_keys.js) and by the
// daily cron. Once `select count(*) from user_api_keys where ciphertext not
// like 'v2:%'` is 0, the v1 path can be deleted (see supabase/README.md).
//
// GCM's tag makes tampering, a wrong AAD, or a rotated secret fail loudly rather
// than yield garbage. Rotating the secret invalidates stored keys (they fail to
// decrypt → marked invalid → user re-enters), which is the safe default.

import crypto from "node:crypto";

const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;
const V2 = "v2:";
const HKDF_SALT = "car-shopper/user-api-keys";
const HKDF_INFO = "aes-256-gcm v2";

function secret() {
  const s = process.env.KEY_ENCRYPTION_SECRET;
  if (!s || s.length < 16) throw new Error("KEY_ENCRYPTION_SECRET is not configured on the server");
  return s;
}
function keyV1() { return crypto.createHash("sha256").update(secret()).digest(); }
function keyV2() { return Buffer.from(crypto.hkdfSync("sha256", secret(), HKDF_SALT, HKDF_INFO, 32)); }

// aad: "<user_id>:<provider>" — required, so every new ciphertext is bound to its row.
export function encrypt(plaintext, aad) {
  if (!aad) throw new Error("encrypt needs the key's owner and provider (aad)");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyV2(), iv);
  cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return V2 + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

// Reads v2 (with the same aad it was written with) or legacy v1 (aad ignored).
export function decrypt(blob, aad) {
  const s = String(blob);
  const v2 = s.indexOf(V2) === 0;
  const buf = Buffer.from(v2 ? s.slice(V2.length) : s, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", v2 ? keyV2() : keyV1(), iv);
  if (v2) decipher.setAAD(Buffer.from(String(aad || ""), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// True for a ciphertext still in the legacy v1 format (to be re-encrypted).
export function isLegacy(blob) { return String(blob || "").indexOf(V2) !== 0; }

// Legacy v1 encrypt — only so tests can produce v1 rows. Never used to store.
export function encryptV1ForTests(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyV1(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

// True if encryption is usable (secret configured). Lets endpoints return a
// clear "not configured" error instead of throwing mid-request.
export function cryptoReady() {
  try { secret(); return true; } catch (e) { return false; }
}
