-- Migration: drop the public demo snapshot table
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run.
--
-- /?demo now runs only over the anonymized fixture bundled with the app
-- (public/demo/snapshot.json, built by scripts/demo-fixture/). The admin
-- "Publish demo" path, which copied the owner's real data into this
-- world-readable table, is gone, so the table (and its read policy) goes too.

drop table if exists public.demo_snapshot;
