-- Migration: public demo snapshot (one row, readable by anyone)
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run.
--
-- /?demo runs the app with no sign-in over a scrubbed copy of the owner's data.
-- That copy lives here: a single row (id = 1) written only by the server
-- (api/snapshots.js, POST { demo }, admins only, via the service role) and
-- readable by everyone, signed in or not. No insert/update/delete policies, so
-- clients can never write it.

create table if not exists public.demo_snapshot (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.demo_snapshot enable row level security;

do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'demo_snapshot'
  loop
    execute format('drop policy %I on public.demo_snapshot', pol.policyname);
  end loop;
end $$;

create policy demo_snapshot_read on public.demo_snapshot
  for select to anon, authenticated
  using (true);

revoke insert, update, delete on public.demo_snapshot from anon, authenticated;
grant select on public.demo_snapshot to anon, authenticated;
