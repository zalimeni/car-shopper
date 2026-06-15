-- Migration: baseline app_state table
--
-- Captures the pre-existing per-user app-state table so the database can be
-- recreated from scratch (fresh project / CI). Idempotent: create-if-not-exists
-- plus drop/create for policies, so it is a no-op on the live database (where
-- the table already exists; the later allowlist migration then tightens these
-- policies to also require allowlist membership).
--
-- Schema mirrors src/storage.js: one JSONB blob per user, keyed by user_id.

create table if not exists public.app_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- Per-user isolation: each account sees only its own row.
drop policy if exists "app_state_owner_select" on public.app_state;
create policy "app_state_owner_select" on public.app_state
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "app_state_owner_insert" on public.app_state;
create policy "app_state_owner_insert" on public.app_state
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "app_state_owner_update" on public.app_state;
create policy "app_state_owner_update" on public.app_state
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "app_state_owner_delete" on public.app_state;
create policy "app_state_owner_delete" on public.app_state
  for delete to authenticated using (auth.uid() = user_id);
