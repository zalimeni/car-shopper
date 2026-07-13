-- Migration: optimistic-concurrency counter on app_state
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run.
--
-- The app state is one JSONB blob per user and cross-device use is supported,
-- so two open sessions could silently last-write-wins each other. `rev` is a
-- monotonic counter: the client sends the rev it loaded and the write only
-- applies when it still matches (compare-and-swap in src/storage.js); a
-- mismatch means another device wrote first, and the client reloads instead
-- of clobbering. Existing rows start at 0.

alter table public.app_state
  add column if not exists rev bigint not null default 0;
