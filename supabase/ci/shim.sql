-- CI-only shim: recreates the Supabase-provided objects our migrations depend on
-- (the `auth` schema, an `auth.users` table, the API roles, auth.uid()/
-- auth.jwt(), and Supabase's default grants) so the migrations can be applied
-- against a plain Postgres in CI. NOT a migration — lives outside
-- supabase/migrations so `supabase db push` never picks it up, and it is never
-- run against the real database (which already provides all of this).
--
-- auth.uid() and auth.jwt() read the JWT claims from the `request.jwt.claims`
-- setting, the same way the hosted versions do. So ci/rls_checks.sql can act
-- as a signed-in user with:
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"…","email":"…"}', true);

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- Supabase's defaults: the API roles can use both schemas, and new objects in
-- public are granted to them (RLS, not grants, is what normally limits access).
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
