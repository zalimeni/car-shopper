// Server-only Supabase admin client for the Anthropic-key vault.
//
// public.user_anthropic_keys has RLS enabled with NO client policies, so anon/
// authenticated callers can't touch it. The server reaches it through the
// Supabase Secret key (sb_secret_…), which bypasses RLS — used only after
// authorize() has confirmed the caller, and always scoped to that caller's own
// user_id.
//
// Reads SUPABASE_SECRET_KEY. Returns null when it isn't configured, so endpoints
// degrade to a clear "not configured" error rather than crashing.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://dispkandrvmycwccavvl.supabase.co";

export function adminClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) return null;
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Anon (publishable) client for public auth flows like sending a magic-link
// sign-in email (signInWithOtp) — used to give an already-registered invitee a
// fresh login link.
export function anonClient() {
  const key =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "sb_publishable_TlJnt8hWo6eeQ1yJV9r0KQ_IbZwbfDk";
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const TABLE = "user_anthropic_keys";

// Returns { configured, valid, last4 } for the user (configured=false if no row,
// no admin client, or on error — the caller treats all of these as "no usable
// key", which is the safe default).
export async function getKeyStatus(userId) {
  const db = adminClient();
  if (!db || !userId) return { configured: false, valid: false, last4: "" };
  const { data, error } = await db
    .from(TABLE)
    .select("valid,last4")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return { configured: false, valid: false, last4: "" };
  return { configured: true, valid: !!data.valid, last4: data.last4 || "" };
}

// Returns the stored ciphertext + valid flag, or null. Caller decrypts.
export async function getKeyRow(userId) {
  const db = adminClient();
  if (!db || !userId) return null;
  const { data, error } = await db
    .from(TABLE)
    .select("ciphertext,valid,last4")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export async function upsertKey(userId, ciphertext, last4) {
  const db = adminClient();
  if (!db) return { error: "Supabase secret key is not configured on the server" };
  const { error } = await db.from(TABLE).upsert({
    user_id: userId,
    ciphertext: ciphertext,
    last4: last4,
    valid: true,
    updated_at: new Date().toISOString(),
  });
  return { error: error ? error.message : null };
}

// Flip the stored key's valid flag (e.g. after Anthropic rejects it at score
// time) so the UI can prompt for a fresh key without deleting the old blob.
export async function setKeyValid(userId, valid) {
  const db = adminClient();
  if (!db) return;
  await db.from(TABLE).update({ valid: valid, updated_at: new Date().toISOString() }).eq("user_id", userId);
}

export async function deleteKey(userId) {
  const db = adminClient();
  if (!db) return { error: "Supabase secret key is not configured on the server" };
  const { error } = await db.from(TABLE).delete().eq("user_id", userId);
  return { error: error ? error.message : null };
}
