-- Migration: drive the scheduled sync from the database (pg_cron + pg_net)
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/tests/scheduled_sync.test.sql.
--
-- Before: one daily Vercel Cron run synced every scheduled_sync account in turn,
-- inside one 60 s function, so later accounts ran out of time. Now a pg_cron job
-- runs public.dispatch_scheduled_sync() every 15 minutes. Each run picks at most
-- a couple of accounts that are due (scheduled_sync on, last attempt about a day
-- ago or never), stamps them, and POSTs one request per account to
-- /api/cron-sync with pg_net — so every account gets its own invocation and its
-- own time budget, staggered across the day.
--
-- The endpoint URL and the bearer secret come from Supabase Vault (secrets named
-- cron_sync_url and cron_secret — see supabase/README.md). This file holds no
-- values: until the owner creates both secrets the dispatcher does nothing, and
-- the daily Vercel cron keeps syncing everyone as before (it asks
-- public.scheduled_sync_dispatcher_ready() which of the two is in charge).
--
-- 1) pg_cron (in pg_catalog, where Supabase keeps it) and pg_net (its functions
--    live in the net schema; Supabase installs it "with schema extensions").
-- 2) allowed_emails.last_scheduled_sync (last attempt — stamped on dispatch, so
--    a failing account is retried a day later, not every tick) and
--    last_scheduled_sync_result (a short outcome the endpoint writes:
--    "dispatched" until the request lands, "started", then ok / skipped / error).
--    allowed_emails stays server-only (no anon/authenticated grants).
-- 3) dispatch_scheduled_sync(batch) and scheduled_sync_dispatcher_ready():
--    SECURITY DEFINER, empty search_path, not executable by anon/authenticated.
-- 4) The pg_cron job 'scheduled-sync-dispatch' (cron.schedule upserts by name).

-- 1) Extensions
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 2) Per-account bookkeeping
alter table public.allowed_emails add column if not exists last_scheduled_sync timestamptz;
alter table public.allowed_emails add column if not exists last_scheduled_sync_result text;
revoke all on table public.allowed_emails from anon, authenticated;

-- 3) The dispatcher
-- Due = scheduled_sync on and no attempt in the last 23 h 50 min. With a tick
-- every 15 minutes that keeps each account on roughly the same time of day
-- (a 23 h threshold would creep ~45 min earlier every day). Oldest first,
-- never-synced accounts before all others.
create or replace function public.dispatch_scheduled_sync(batch int default 2)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  acct record;
  n int := 0;
begin
  select max(s.decrypted_secret) filter (where s.name = 'cron_sync_url'),
         max(s.decrypted_secret) filter (where s.name = 'cron_secret')
    into v_url, v_secret
  from vault.decrypted_secrets s
  where s.name in ('cron_sync_url', 'cron_secret');
  if coalesce(trim(v_url), '') = '' or coalesce(trim(v_secret), '') = '' then
    return 0; -- not configured: a clean no-op
  end if;

  for acct in
    update public.allowed_emails a
    set last_scheduled_sync = now(), last_scheduled_sync_result = 'dispatched'
    where a.email in (
      select d.email from public.allowed_emails d
      where d.scheduled_sync
        and (d.last_scheduled_sync is null or d.last_scheduled_sync < now() - interval '23 hours 50 minutes')
      order by d.last_scheduled_sync asc nulls first, d.email
      limit greatest(coalesce(batch, 2), 0)
      for update skip locked
    )
    returning a.email
  loop
    perform net.http_post(
      url := trim(v_url),
      body := jsonb_build_object('email', acct.email),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || trim(v_secret)),
      -- The function may run up to its 60 s maxDuration; don't hang up first.
      timeout_milliseconds := 70000
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.dispatch_scheduled_sync(int) from public, anon, authenticated;

-- Whether the database dispatcher is in charge: its job is scheduled and active
-- and both Vault secrets exist. The daily Vercel cron (service role) asks this;
-- when true it only does maintenance, otherwise it syncs due accounts itself.
create or replace function public.scheduled_sync_dispatcher_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from cron.job j
      where j.jobname = 'scheduled-sync-dispatch' and j.active)
    and (select count(*) from vault.decrypted_secrets s
         where s.name in ('cron_sync_url', 'cron_secret')
           and coalesce(trim(s.decrypted_secret), '') <> '') = 2;
$$;
revoke all on function public.scheduled_sync_dispatcher_ready() from public, anon, authenticated;
grant execute on function public.scheduled_sync_dispatcher_ready() to service_role;

-- 4) The schedule (cron.schedule with an existing name updates that job)
select cron.schedule(
  'scheduled-sync-dispatch',
  '*/15 * * * *',
  'select public.dispatch_scheduled_sync(2)'
);
