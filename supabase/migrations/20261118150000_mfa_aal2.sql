-- Migration: TOTP multi-factor auth (Supabase Auth MFA) enforced in the database
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/tests/mfa.test.sql.
--
-- Sign-in is by email (magic link / pasted link / one-time code), so anyone in
-- the user's inbox gets an aal1 session. Once a user has a verified TOTP
-- factor, an aal1 token must not reach their data; it has to be stepped up to
-- aal2 with a code first (src/Auth.jsx). Users with no factor are unaffected.
--
-- 1) public.mfa_ok(): true when the caller's token is aal2, or the caller has
--    no verified factor. SECURITY DEFINER because `authenticated` has no grant
--    on auth.mfa_factors (so Supabase's documented inline subquery would fail
--    with "permission denied" here); it only ever answers for auth.uid().
-- 2) RESTRICTIVE policies on app_state (every command) AND-ed with the existing
--    permissive ones, so a stolen aal1 token can't read or write the blob via
--    PostgREST, save_app_state() (SECURITY INVOKER, so RLS applies to it) or
--    Realtime (which checks the subscriber's claims against the same RLS).
--    The other client-reachable tables need nothing: demo_snapshot is public
--    on purpose and every other table is server-only.
-- 3) The same restrictive rule on storage.objects, for every bucket, so any
--    bucket's own policies are narrowed the same way. (Public-bucket downloads
--    by URL don't go through RLS at all.) Skipped where storage isn't installed.
-- 4) my_access_mfa(): my_access() plus has_mfa, so api/_auth.js can reject an
--    aal1 token from an enrolled user without an extra Auth-server call (still
--    one RPC per request; _auth.js now calls this one). It's a new function,
--    not a new column on my_access(): that would change my_access()'s return
--    type, and re-running 20261111120000_access_and_key_vault.sql (CI re-applies
--    every migration to prove idempotency) would then fail on its
--    `create or replace`. my_access() is left as it was.

-- 1) Helper
create or replace function public.mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = auth.uid() and f.status = 'verified'
      );
$$;
revoke all on function public.mfa_ok() from public, anon;
grant execute on function public.mfa_ok() to authenticated;

-- 2) app_state
drop policy if exists "app_state_mfa" on public.app_state;
create policy "app_state_mfa" on public.app_state
  as restrictive
  for all to authenticated
  using ((select public.mfa_ok()))
  with check ((select public.mfa_ok()));

-- 3) storage.objects
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "objects_mfa" on storage.objects';
    execute 'create policy "objects_mfa" on storage.objects as restrictive for all to authenticated '
         || 'using ((select public.mfa_ok())) with check ((select public.mfa_ok()))';
  end if;
end $$;

-- 4) my_access_mfa()
create or replace function public.my_access_mfa()
returns table (allowed boolean, admin boolean, has_mfa boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) > 0,
         coalesce(bool_or(a.is_admin), false),
         exists (
           select 1 from auth.mfa_factors f
           where f.user_id = auth.uid() and f.status = 'verified'
         )
  from public.allowed_emails a
  where lower(a.email) = lower(auth.jwt() ->> 'email');
$$;
revoke all on function public.my_access_mfa() from public, anon;
grant execute on function public.my_access_mfa() to authenticated;
