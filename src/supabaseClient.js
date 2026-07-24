import { createClient, processLock } from "@supabase/supabase-js";

// The Supabase URL and publishable ("anon") key are safe to expose in the
// browser — data access is protected by Row Level Security, not by hiding
// these values. They can be overridden per-environment via VITE_ env vars
// (see .env.example); the defaults below point at the project's instance so
// the deployed app works without extra configuration.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://dispkandrvmycwccavvl.supabase.co";
const SUPABASE_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "sb_publishable_TlJnt8hWo6eeQ1yJV9r0KQ_IbZwbfDk";

// flowType "implicit": magic-link tokens arrive in the URL hash, so sign-in
// works even when the link is opened in a fresh context (private/incognito tab,
// or a different browser than where it was requested). The default PKCE flow
// needs a code verifier stashed in the requesting tab's storage — absent in a
// fresh tab — which left the auth client wedged and the app hung on load.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    flowType: "implicit",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
    // Use the in-memory lock instead of the default Web Locks (navigator.locks)
    // lock. The default can DEADLOCK across tabs — a lock held by another
    // (possibly backgrounded/dead) tab makes getSession()/getUser() hang
    // forever, which stuck an already-authenticated tab on "Loading…" on
    // reload. processLock serializes auth calls within this tab without the
    // cross-tab lock that wedges.
    lock: processLock,
  },
});
