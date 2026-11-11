// Server-only Supabase clients.
//
// The server-only tables (allowed_emails, user_api_keys, app_state_history) have
// RLS enabled with NO client policies and no anon/authenticated grants, so the
// browser can't touch them. The server reaches them through the Supabase Secret
// key (sb_secret_…), which bypasses RLS — used only after authorize() has
// confirmed the caller, and always scoped to that caller's own user_id (or, in
// the cron, to the accounts allowed_emails marks for scheduled sync).
//
// Reads SUPABASE_SECRET_KEY. adminClient() returns null when it isn't
// configured, so endpoints degrade to a clear "not configured" error.

import { createClient } from "@supabase/supabase-js";

// Project URL + publishable key: public values (RLS protects the data), the
// same defaults and VITE_* overrides as src/supabaseClient.js.
export const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://dispkandrvmycwccavvl.supabase.co";
export const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_TlJnt8hWo6eeQ1yJV9r0KQ_IbZwbfDk";

export function adminClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) return null;
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Publishable-key client for public auth flows like sending a magic-link
// sign-in email (signInWithOtp) — used to give an already-registered invitee a
// fresh login link.
export function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
