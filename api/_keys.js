// The per-user API-key vault: public.user_api_keys (server-only; see
// supabase/migrations/*_access_and_key_vault.sql). One Anthropic key per user
// and an ordered list of MarketCheck keys, each encrypted with api/_crypto.js
// (AES-256-GCM, bound to "<user_id>:<provider>").
//
// Every endpoint that needs a key goes through this module: the decrypt calls
// live here and nowhere else. Plaintext keys never leave the server; what the
// browser sees is metadata (id, label, last4, valid).
//
// Legacy v1 ciphertexts (from the old user_anthropic_keys vault) are
// re-encrypted to v2 when read, and reencryptLegacy() (daily cron) sweeps the
// rest — see supabase/README.md "Key encryption v2".

import { adminClient } from "./_supabaseAdmin.js";
import { encrypt, decrypt, isLegacy } from "./_crypto.js";
import { legacyBlobKeys } from "../src/quota.js";

const TABLE = "user_api_keys";
export const PROVIDERS = ["anthropic", "marketcheck"];
const aadOf = function (userId, provider) { return userId + ":" + provider; };

function noDb() { return { error: "Supabase secret key is not configured on the server" }; }

async function rows(db, userId, provider) {
  const { data, error } = await db.from(TABLE).select("id,provider,position,label,ciphertext,last4,valid")
    .eq("user_id", userId).eq("provider", provider).order("position", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// Decrypt one row; a v1 row is rewritten as v2 on the way (best effort).
async function open(db, userId, row) {
  const key = decrypt(row.ciphertext, aadOf(userId, row.provider));
  if (isLegacy(row.ciphertext)) {
    try { await db.from(TABLE).update({ ciphertext: encrypt(key, aadOf(userId, row.provider)) }).eq("id", row.id); } catch (e) { /* retried next read / cron */ }
  }
  return key;
}

// ── Metadata (what the browser may see) ──

// -> { anthropic: { configured, valid, last4 }, marketcheck: [{ id, label, last4, position, valid }] }
export async function keyMeta(userId) {
  const empty = { anthropic: { configured: false, valid: false, last4: "" }, marketcheck: [] };
  const db = adminClient();
  if (!db || !userId) return empty;
  try {
    const { data, error } = await db.from(TABLE).select("id,provider,position,label,last4,valid")
      .eq("user_id", userId).order("position", { ascending: true }).order("id", { ascending: true });
    if (error) return empty;
    const out = { anthropic: empty.anthropic, marketcheck: [] };
    (data || []).forEach(function (r) {
      if (r.provider === "anthropic") out.anthropic = { configured: true, valid: !!r.valid, last4: r.last4 || "" };
      if (r.provider === "marketcheck") out.marketcheck.push({ id: r.id, label: r.label || "", last4: r.last4 || "", position: r.position, valid: !!r.valid });
    });
    return out;
  } catch (e) { return empty; }
}

// ── Anthropic ──

// -> { key } or { error: "no_key" | "key_unreadable" | "not_configured", message }
export async function getAnthropicKey(userId) {
  const db = adminClient();
  if (!db) return { error: "not_configured", message: noDb().error };
  let list;
  try { list = await rows(db, userId, "anthropic"); } catch (e) { return { error: "not_configured", message: e.message }; }
  if (!list.length) return { error: "no_key", message: "No Anthropic key on file — add one in Settings" };
  try { return { key: await open(db, userId, list[0]) }; }
  catch (e) {
    await setAnthropicValid(userId, false);
    return { error: "key_unreadable", message: "Stored key couldn't be decrypted — re-enter it" };
  }
}

export async function setAnthropicKey(userId, key) {
  const db = adminClient();
  if (!db) return noDb();
  const row = { ciphertext: encrypt(key, aadOf(userId, "anthropic")), last4: key.slice(-4), valid: true, updated_at: new Date().toISOString() };
  const existing = await rows(db, userId, "anthropic").catch(function () { return []; });
  const r = existing.length
    ? await db.from(TABLE).update(row).eq("id", existing[0].id)
    : await db.from(TABLE).insert(Object.assign({ user_id: userId, provider: "anthropic", position: 0, label: "" }, row));
  return { error: r.error ? r.error.message : null };
}

// Flip the stored key's valid flag (e.g. after Anthropic rejects it) so the UI
// can prompt for a fresh key without deleting the old one.
export async function setAnthropicValid(userId, valid) {
  const db = adminClient();
  if (!db) return;
  await db.from(TABLE).update({ valid: valid, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("provider", "anthropic");
}

export async function deleteAnthropicKey(userId) {
  const db = adminClient();
  if (!db) return noDb();
  const { error } = await db.from(TABLE).delete().eq("user_id", userId).eq("provider", "anthropic");
  return { error: error ? error.message : null };
}

// ── MarketCheck ──

// The user's MarketCheck keys, decrypted, in the order they're used. A key that
// fails to decrypt is skipped (and flagged invalid). [] = none (the shared key
// applies, api/marketcheck.js resolveKeys).
export async function getMarketcheckKeys(userId) {
  const db = adminClient();
  if (!db || !userId) return [];
  const list = await rows(db, userId, "marketcheck").catch(function () { return []; });
  const out = [];
  for (const r of list) {
    try { out.push(await open(db, userId, r)); }
    catch (e) { await db.from(TABLE).update({ valid: false }).eq("id", r.id); }
  }
  return out;
}

// A MarketCheck key as far as we can tell without spending a paid call.
export function looksLikeMarketcheckKey(k) { return /^[A-Za-z0-9_-]{16,128}$/.test(String(k || "")); }

// Append keys ([{ key, label }]) after the existing ones, skipping any already
// stored. -> { added, error }
export async function addMarketcheckKeys(userId, entries) {
  const db = adminClient();
  if (!db) return Object.assign({ added: 0 }, noDb());
  const list = await rows(db, userId, "marketcheck");
  const have = {};
  for (const r of list) { try { have[await open(db, userId, r)] = true; } catch (e) { /* unreadable: not a duplicate of anything */ } }
  let pos = list.reduce(function (m, r) { return Math.max(m, r.position); }, -1);
  const add = [];
  (entries || []).forEach(function (e) {
    const key = String((e && e.key) || "").trim();
    if (!key || have[key]) return;
    have[key] = true;
    pos++;
    add.push({ user_id: userId, provider: "marketcheck", position: pos, label: String((e && e.label) || "").trim().slice(0, 60), ciphertext: encrypt(key, aadOf(userId, "marketcheck")), last4: key.slice(-4), valid: true });
  });
  if (!add.length) return { added: 0, error: null };
  const { error } = await db.from(TABLE).insert(add);
  return { added: error ? 0 : add.length, error: error ? error.message : null };
}

// Rename one key and/or set the order (ids, first = used first). Ids that aren't
// the caller's are ignored by the user_id filter.
export async function updateMarketcheckKeys(userId, opts) {
  const db = adminClient();
  if (!db) return noDb();
  const now = new Date().toISOString();
  if (opts && opts.id != null && typeof opts.label === "string") {
    const { error } = await db.from(TABLE).update({ label: opts.label.trim().slice(0, 60), updated_at: now }).eq("user_id", userId).eq("provider", "marketcheck").eq("id", opts.id);
    if (error) return { error: error.message };
  }
  if (opts && Array.isArray(opts.order)) {
    for (let i = 0; i < opts.order.length; i++) {
      const { error } = await db.from(TABLE).update({ position: i, updated_at: now }).eq("user_id", userId).eq("provider", "marketcheck").eq("id", opts.order[i]);
      if (error) return { error: error.message };
    }
  }
  return { error: null };
}

export async function deleteMarketcheckKey(userId, id) {
  const db = adminClient();
  if (!db) return noDb();
  const { error } = await db.from(TABLE).delete().eq("user_id", userId).eq("provider", "marketcheck").eq("id", id);
  return { error: error ? error.message : null };
}

// ── One-time moves and sweeps ──

// Move any plaintext keys in `settings` into the vault. -> true when the blob's
// copy can be dropped (moved, or there was nothing to move).
export async function importBlobKeys(userId, settings) {
  const list = legacyBlobKeys(settings);
  if (!list.length) return true;
  const r = await addMarketcheckKeys(userId, list).catch(function (e) { return { error: e.message }; });
  return !r.error;
}

// Re-encrypt every remaining v1 row as v2 (daily cron). -> { rewritten, failed }
export async function reencryptLegacy(db) {
  const out = { rewritten: 0, failed: 0 };
  const { data, error } = await db.from(TABLE).select("id,user_id,provider,ciphertext").not("ciphertext", "like", "v2:%").limit(500);
  if (error) return Object.assign(out, { error: error.message });
  for (const r of data || []) {
    try {
      const key = decrypt(r.ciphertext);
      const u = await db.from(TABLE).update({ ciphertext: encrypt(key, aadOf(r.user_id, r.provider)) }).eq("id", r.id);
      if (u.error) out.failed++; else out.rewritten++;
    } catch (e) { out.failed++; }
  }
  return out;
}
