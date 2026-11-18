-- Migration: drop the old Anthropic-key table (user_anthropic_keys)
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/tests/rls.test.sql.
--
-- 20261111120000_access_and_key_vault.sql copied its rows into user_api_keys
-- (the vault), and the server re-encrypted every v1 ciphertext to v2 there.
-- Nothing reads this table any more, and api/_crypto.js no longer reads v1.
-- Before applying, both of these should be 0:
--   select count(*) from public.user_api_keys where ciphertext not like 'v2:%';
--   select count(*) from public.user_anthropic_keys k
--   where not exists (select 1 from public.user_api_keys u
--                     where u.user_id = k.user_id and u.provider = 'anthropic');
--
-- (Re-running the older migrations in order recreates the empty table, and this
-- one drops it again.)

drop table if exists public.user_anthropic_keys;
