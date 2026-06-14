-- Server-enforced user allowlist at the database (RLS) layer.
--
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL) or via
-- `supabase db` against the project. It is safe to re-run (idempotent).
--
-- After this runs, only emails present in public.allowed_emails can read or
-- write app_state — no matter how they authenticate. Manage access by
-- inserting/deleting rows in that table. The /api proxy reads the same list
-- through is_allowed(), so this table is the single source of truth for both
-- the data layer and the serverless endpoints.

-- 1) Allowlist table. RLS enabled with NO client policies => not readable or
--    writable by anon/authenticated clients; manage it from the SQL editor.
create table if not exists public.allowed_emails (
  email    text primary key,
  added_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security;

-- 2) Seed the owner.
insert into public.allowed_emails (email)
values ('mzalimeni@gmail.com')
on conflict (email) do nothing;

-- 3) Helper: is the current (JWT) user allowlisted? SECURITY DEFINER so it can
--    read the locked-down table on the caller's behalf, returning only a bool.
create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(auth.jwt() ->> 'email')
  );
$$;
revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;

-- 4) Re-create app_state policies to require allowlist membership in addition to
--    the existing per-user isolation. Drops whatever policies exist first so the
--    end state is deterministic regardless of their current names.
alter table public.app_state enable row level security;

do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'app_state'
  loop
    execute format('drop policy %I on public.app_state', pol.policyname);
  end loop;
end $$;

create policy "app_state_select" on public.app_state
  for select to authenticated
  using (auth.uid() = user_id and public.is_allowed());

create policy "app_state_insert" on public.app_state
  for insert to authenticated
  with check (auth.uid() = user_id and public.is_allowed());

create policy "app_state_update" on public.app_state
  for update to authenticated
  using (auth.uid() = user_id and public.is_allowed())
  with check (auth.uid() = user_id and public.is_allowed());

create policy "app_state_delete" on public.app_state
  for delete to authenticated
  using (auth.uid() = user_id and public.is_allowed());
