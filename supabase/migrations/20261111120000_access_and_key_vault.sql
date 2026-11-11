-- Migration: allowlist flags + one key vault for every provider
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/tests/access.test.sql.
--
-- 1) allowed_emails is the only allowlist (the ALLOWED_EMAILS / ADMIN_EMAILS /
--    CRON_SYNC_EMAILS env vars are gone). Two flags per row: is_admin (Admin
--    tab, Publish demo) and scheduled_sync (the daily background sync runs for
--    this account). The owner is seeded with both. public.my_access() answers
--    "allowed? admin?" for the signed-in user in one call (api/_auth.js).
-- 2) public.user_api_keys holds every user's API keys, encrypted by the server
--    (api/_crypto.js): one Anthropic key and an ordered list of MarketCheck
--    keys. Server-only: RLS on, no policies, no anon/authenticated grants.
--    Existing rows of user_anthropic_keys are copied in unchanged (their
--    ciphertext is the legacy v1 format; the server re-encrypts it to v2 on
--    first read and in the daily cron). user_anthropic_keys itself is left in
--    place until a later migration drops it — see supabase/README.md.
-- 3) MarketCheck keys used to live in each user's app-state blob
--    (settings.marketcheckKeys). The app now moves them into the vault, so
--    backups must not keep a copy: the snapshot trigger strips them, and
--    existing snapshots are scrubbed here. (The live app_state row keeps its
--    copy until the app or the cron has moved it.)
--    The trigger also skips the snapshot when the row goes because its user is
--    being deleted (auth.users cascade): there is no user to keep it for, and
--    the insert failed the foreign key, which blocked deleting the user at all.

-- 1) Allowlist flags
alter table public.allowed_emails add column if not exists is_admin boolean not null default false;
alter table public.allowed_emails add column if not exists scheduled_sync boolean not null default false;

insert into public.allowed_emails (email) values ('mzalimeni@gmail.com')
on conflict (email) do nothing;
-- Seed the owner's flags only while nobody holds them, so a re-run never undoes
-- a choice made later in the Admin tab.
update public.allowed_emails set is_admin = true
where email = 'mzalimeni@gmail.com'
  and not exists (select 1 from public.allowed_emails where is_admin);
update public.allowed_emails set scheduled_sync = true
where email = 'mzalimeni@gmail.com'
  and not exists (select 1 from public.allowed_emails where scheduled_sync);

create or replace function public.my_access()
returns table (allowed boolean, admin boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) > 0, coalesce(bool_or(a.is_admin), false)
  from public.allowed_emails a
  where lower(a.email) = lower(auth.jwt() ->> 'email');
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

-- 2) Key vault
create table if not exists public.user_api_keys (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  provider   text not null check (provider in ('anthropic', 'marketcheck')),
  position   int not null default 0,
  label      text not null default '',
  ciphertext text not null,
  last4      text not null default '',
  valid      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists user_api_keys_one_anthropic
  on public.user_api_keys (user_id) where provider = 'anthropic';
create index if not exists user_api_keys_user_idx
  on public.user_api_keys (user_id, provider, position);

alter table public.user_api_keys enable row level security;
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'user_api_keys'
  loop
    execute format('drop policy %I on public.user_api_keys', pol.policyname);
  end loop;
end $$;
revoke all on table public.user_api_keys from anon, authenticated;

insert into public.user_api_keys (user_id, provider, position, ciphertext, last4, valid, created_at, updated_at)
select k.user_id, 'anthropic', 0, k.ciphertext, k.last4, k.valid, k.created_at, k.updated_at
from public.user_anthropic_keys k
where not exists (
  select 1 from public.user_api_keys u where u.user_id = k.user_id and u.provider = 'anthropic'
);

-- 3) No MarketCheck keys in backups
create or replace function public.app_state_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;
  if tg_op = 'DELETE' or not exists (
    select 1 from app_state_history
    where user_id = old.user_id
      and saved_at > now() - interval '60 minutes'
  ) then
    insert into app_state_history (user_id, data)
      values (old.user_id, old.data #- '{settings,marketcheckKeys}');
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
revoke all on function public.app_state_snapshot() from public, anon, authenticated;

update public.app_state_history
set data = data #- '{settings,marketcheckKeys}'
where data #> '{settings,marketcheckKeys}' is not null;
