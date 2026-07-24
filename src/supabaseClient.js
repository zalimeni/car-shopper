import { createClient } from "@supabase/supabase-js";

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

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
