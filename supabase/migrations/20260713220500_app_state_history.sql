-- Migration: app_state history snapshots (server-only)
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run.
--
-- The whole app state is one JSONB blob per user, so a single bad write can
-- lose everything. This keeps rolling snapshots of the blob as insurance:
-- a BEFORE trigger on public.app_state copies the OLD row into
-- public.app_state_history before an update overwrites it (throttled to one
-- per hour so a burst of edits doesn't churn the whole window) and always
-- before a delete. The most recent 30 snapshots per user are kept.
--
-- RLS is enabled with NO client policies — only the server (service role, via
-- api/snapshots.js) can list or restore snapshots, always scoped to the
-- authenticated caller's own user_id.

create table if not exists public.app_state_history (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  data     jsonb not null,
  saved_at timestamptz not null default now()
);

create index if not exists app_state_history_user_idx
  on public.app_state_history (user_id, saved_at desc);

alter table public.app_state_history enable row level security;

-- Defensively drop any policies that might exist from a prior run, so the end
-- state is deterministically "no client access".
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'app_state_history'
  loop
    execute format('drop policy %I on public.app_state_history', pol.policyname);
  end loop;
end $$;

-- Snapshot trigger. BEFORE UPDATE must return NEW (else the update is
-- silently skipped); BEFORE DELETE must return OLD.
create or replace function public.app_state_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' or not exists (
    select 1 from app_state_history
    where user_id = old.user_id
      and saved_at > now() - interval '60 minutes'
  ) then
    insert into app_state_history (user_id, data) values (old.user_id, old.data);
    delete from app_state_history h
    where h.user_id = old.user_id
      and h.id not in (
        select id from app_state_history
        where user_id = old.user_id
        order by saved_at desc, id desc
        limit 30
      );
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists app_state_snapshot_trg on public.app_state;
create trigger app_state_snapshot_trg
  before update or delete on public.app_state
  for each row execute function public.app_state_snapshot();
