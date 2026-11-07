-- Migration: tighten table grants and RLS policies
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/ci/rls_checks.sql.
--
-- 1) Grants. Supabase grants ALL on every new public table to the anon and
--    authenticated roles, and RLS is what limits access. The server-only
--    tables (allowed_emails, user_anthropic_keys, app_state_history) have RLS
--    with no policies, so the Data API already returns nothing. Revoking the
--    grants too means a later policy mistake, or RLS turned off by accident,
--    still cannot expose them. demo_snapshot keeps SELECT only (the earlier
--    migration revoked writes but left TRUNCATE, REFERENCES and TRIGGER).
--    app_state keeps the four DML grants for signed-in users and none for anon.
-- 2) RLS policy calls. The app_state policies wrap auth.uid() and is_allowed()
--    in a scalar subquery, so Postgres runs each once per statement (an
--    initPlan), not once per row. This is the fix for the Supabase Performance
--    Advisor lint "auth_rls_initplan".
-- 3) is_allowed() compares emails case-insensitively on both sides, so a row
--    added by hand in the SQL editor with capital letters still matches. Its
--    search_path is now empty, as the Security Advisor recommends.
-- 4) Trigger functions cannot be called through the Data API, but they get the
--    default EXECUTE grant. Revoke it (triggers do not check it when they fire).

-- 1) Grants
revoke all on table public.allowed_emails      from anon, authenticated;
revoke all on table public.user_anthropic_keys from anon, authenticated;
revoke all on table public.app_state_history   from anon, authenticated;

revoke all on table public.demo_snapshot from anon, authenticated;
grant select on table public.demo_snapshot to anon, authenticated;

revoke all on table public.app_state from anon, authenticated;
grant select, insert, update, delete on table public.app_state to authenticated;

-- 3) Allowlist check (before the policies that call it)
create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;
revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;

-- 2) app_state policies: same rules as 20260614180900_user_allowlist.sql,
--    with each function call evaluated once per statement.
drop policy if exists "app_state_select" on public.app_state;
create policy "app_state_select" on public.app_state
  for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_allowed()));

drop policy if exists "app_state_insert" on public.app_state;
create policy "app_state_insert" on public.app_state
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_allowed()));

drop policy if exists "app_state_update" on public.app_state;
create policy "app_state_update" on public.app_state
  for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_allowed()))
  with check ((select auth.uid()) = user_id and (select public.is_allowed()));

drop policy if exists "app_state_delete" on public.app_state;
create policy "app_state_delete" on public.app_state
  for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_allowed()));

-- 4) Trigger function
revoke all on function public.app_state_snapshot() from public, anon, authenticated;
