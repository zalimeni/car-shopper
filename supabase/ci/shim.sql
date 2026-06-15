-- CI-only shim: recreates the Supabase-provided objects our migrations depend on
-- (the `auth` schema, an `auth.users` table, the auth roles, and auth.uid()/
-- auth.jwt()) so the migrations can be applied against a plain Postgres in CI to
-- verify they run cleanly. NOT a migration — lives outside supabase/migrations
-- so `supabase db push` never picks it up, and it is never run against the real
-- database (which already provides all of this).

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create or replace function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select '{}'::jsonb $$;
