-- pgTAP: the database-driven scheduled sync (pg_cron + pg_net). Run with
-- `supabase test db` (CI: .github/workflows/migrations.yml). Everything runs in
-- one transaction that is rolled back at the end — including the pg_net
-- requests the dispatcher queues: pg_net's worker only sends committed rows, so
-- nothing ever leaves the database. See rls.test.sql for how a check acts as a
-- signed-in user.

begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- ── Extensions + the job ──
select ok(exists (select 1 from pg_extension where extname = 'pg_cron'), 'pg_cron is installed');
select ok(exists (select 1 from pg_extension where extname = 'pg_net'), 'pg_net is installed');
select ok(exists (
    select 1 from cron.job
    where jobname = 'scheduled-sync-dispatch' and active
      and schedule = '*/15 * * * *'
      and command = 'select public.dispatch_scheduled_sync(2)'),
  'the dispatcher is scheduled every 15 minutes');
select is((select count(*)::int from cron.job where jobname = 'scheduled-sync-dispatch'), 1, 'exactly one dispatcher job');

-- ── Fixtures (as postgres, so RLS does not apply) ──
-- No Vault secrets yet (CI's database has none; drop any a local one has —
-- rolled back at the end).
delete from vault.secrets where name in ('cron_sync_url', 'cron_secret');
update public.allowed_emails set scheduled_sync = false; -- only the fixtures below are opted in
insert into public.allowed_emails (email, scheduled_sync, last_scheduled_sync) values
  ('never@example.com',  true,  null),
  ('recent@example.com', true,  now() - interval '1 hour'),
  ('stale@example.com',  true,  now() - interval '2 days'),
  ('off@example.com',    false, null)
on conflict (email) do update
  set scheduled_sync = excluded.scheduled_sync, last_scheduled_sync = excluded.last_scheduled_sync;
create temp table q0 as select coalesce(max(id), 0) as id from net.http_request_queue;

-- ── Not configured: a clean no-op ──
select is(public.dispatch_scheduled_sync(5), 0, 'without the Vault secrets the dispatcher dispatches nothing');
select is((select count(*)::int from net.http_request_queue where id > (select id from q0)), 0, '… queues no HTTP request');
select ok((select last_scheduled_sync is null from public.allowed_emails where email = 'never@example.com'), '… and stamps nobody');
select ok(not public.scheduled_sync_dispatcher_ready(), 'scheduled_sync_dispatcher_ready() is false without the secrets');

select vault.create_secret('https://example.invalid/api/cron-sync', 'cron_sync_url');
select ok(not public.scheduled_sync_dispatcher_ready(), '… and with only one of them');
select is(public.dispatch_scheduled_sync(5), 0, 'one secret alone is still a no-op');

-- ── Configured ──
select vault.create_secret('test-cron-secret-0123456789', 'cron_secret');
select ok(public.scheduled_sync_dispatcher_ready(), 'ready once the job and both secrets exist');
select is(public.dispatch_scheduled_sync(1), 1, 'the batch size caps one run');
select is(
  (select convert_from(body, 'UTF8')::jsonb ->> 'email' from net.http_request_queue where id > (select id from q0)),
  'never@example.com', 'never-synced accounts go first');
select is(public.dispatch_scheduled_sync(5), 1, 'the next run takes the remaining due account');
select is(
  (select array_agg(convert_from(body, 'UTF8')::jsonb ->> 'email' order by id) from net.http_request_queue where id > (select id from q0)),
  array['never@example.com', 'stale@example.com'], 'only due, opted-in accounts are dispatched (not recent, not off)');
select ok(
  (select bool_and(method = 'POST' and url = 'https://example.invalid/api/cron-sync'
                   and headers ->> 'Authorization' = 'Bearer test-cron-secret-0123456789'
                   and headers ->> 'Content-Type' = 'application/json')
   from net.http_request_queue where id > (select id from q0)),
  'each request POSTs to the Vault URL with the bearer secret');
select ok(
  (select bool_and(last_scheduled_sync > now() - interval '1 minute' and last_scheduled_sync_result = 'dispatched')
   from public.allowed_emails where email in ('never@example.com', 'stale@example.com')),
  'dispatched accounts are stamped on attempt');
select is(public.dispatch_scheduled_sync(5), 0, 'a stamped account is not dispatched again on the next tick');

-- ── Not for clients ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"never@example.com","role":"authenticated"}', true);
select throws_ok('select public.dispatch_scheduled_sync(1)', '42501', null, 'authenticated cannot run the dispatcher');
select throws_ok('select public.scheduled_sync_dispatcher_ready()', '42501', null, 'authenticated cannot call scheduled_sync_dispatcher_ready()');
select throws_ok('select last_scheduled_sync, last_scheduled_sync_result from public.allowed_emails', '42501', null, 'authenticated cannot read the sync bookkeeping');
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok('select public.dispatch_scheduled_sync(1)', '42501', null, 'anon cannot run the dispatcher');
select throws_ok('select public.scheduled_sync_dispatcher_ready()', '42501', null, 'anon cannot call scheduled_sync_dispatcher_ready()');
reset role;

set local role service_role;
select ok(public.scheduled_sync_dispatcher_ready(), 'the server (service role) can ask whether the dispatcher is in charge');
reset role;

select * from finish();
rollback;
