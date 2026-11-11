-- pgTAP: RLS policies, grants and save_app_state(), checked as the roles the
-- Supabase Data API uses (anon, authenticated). Run with `supabase test db`
-- (CI: .github/workflows/migrations.yml). Everything runs in one transaction
-- that is rolled back at the end.
--
-- To act as a signed-in user, a check sets the role and the JWT claims, the
-- same way PostgREST does for each request:
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"…","email":"…"}', true);

begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- ── Fixtures (as postgres, so RLS does not apply) ──
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'friend@example.com'),
  ('00000000-0000-0000-0000-0000000000c3', 'stranger@example.com'),
  ('00000000-0000-0000-0000-0000000000d4', 'newbie@example.com');
-- Mixed case on purpose: is_allowed() must match it case-insensitively.
insert into public.allowed_emails (email) values ('owner@example.com'), ('Friend@Example.com'), ('newbie@example.com')
  on conflict do nothing;
insert into public.app_state (user_id, data) values
  ('00000000-0000-0000-0000-0000000000a1', '{"who":"owner"}'),
  ('00000000-0000-0000-0000-0000000000b2', '{"who":"friend"}'),
  ('00000000-0000-0000-0000-0000000000c3', '{"who":"stranger"}');
insert into public.user_anthropic_keys (user_id, ciphertext, last4)
  values ('00000000-0000-0000-0000-0000000000a1', 'opaque', 'abcd');
insert into public.demo_snapshot (id, data) values (1, '{"demo":true}')
  on conflict (id) do update set data = excluded.data;

-- ── Allowlisted owner ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"owner@example.com","role":"authenticated"}', true);

select ok(public.is_allowed(), 'is_allowed() is true for an allowlisted email');
select is((select count(*)::int from public.app_state), 1, 'owner sees exactly one app_state row');
select is((select data ->> 'who' from public.app_state), 'owner', 'that row is the owner''s own');

select lives_ok(
  $q$update public.app_state set data = '{"who":"owner","edited":true}' where user_id = '00000000-0000-0000-0000-0000000000a1'$q$,
  'owner can update their own row');
select is((select (data ->> 'edited')::boolean from public.app_state), true, 'the update landed');
select is_empty(
  $q$update public.app_state set data = '{"hacked":true}' where user_id = '00000000-0000-0000-0000-0000000000b2' returning 1$q$,
  'owner cannot update another user''s row');
select is_empty(
  $q$delete from public.app_state where user_id = '00000000-0000-0000-0000-0000000000b2' returning 1$q$,
  'owner cannot delete another user''s row');
select throws_ok(
  $q$insert into public.app_state (user_id, data) values ('00000000-0000-0000-0000-0000000000d4', '{}')$q$,
  '42501', null, 'owner cannot insert a row for another user id');

select throws_ok('select * from public.allowed_emails', '42501', null, 'authenticated cannot read allowed_emails');
select throws_ok('select * from public.user_anthropic_keys', '42501', null, 'authenticated cannot read user_anthropic_keys');
select throws_ok('select * from public.app_state_history', '42501', null, 'authenticated cannot read app_state_history');
select throws_ok($q$insert into public.allowed_emails (email) values ('me@example.com')$q$, '42501', null, 'authenticated cannot add itself to allowed_emails');
select throws_ok($q$update public.demo_snapshot set data = '{}'$q$, '42501', null, 'authenticated cannot write demo_snapshot');
select throws_ok('truncate public.app_state', '42501', null, 'authenticated cannot truncate app_state');
select is((select count(*)::int from public.demo_snapshot), 1, 'authenticated can read demo_snapshot');

-- save_app_state(): compare-and-swap on rev, as the owner (stored rev is 0).
select is(public.save_app_state('{"v":1}', 0), '{"ok":true,"rev":1}'::jsonb, 'save with the current rev writes, rev + 1');
select is(public.save_app_state('{"v":2}', 0) - 'data', '{"ok":false,"rev":1}'::jsonb, 'save with a stale rev is a conflict');
select is(public.save_app_state('{"v":2}', 0) -> 'data', '{"v":1}'::jsonb, 'the conflict carries the stored data');
select is((select data ->> 'v' from public.app_state), '1', 'a conflict writes nothing');
select is(public.save_app_state('{"v":3}', null), '{"ok":true,"rev":2}'::jsonb, 'a null rev writes regardless');
select is(public.save_app_state('{"v":4}', 2), '{"ok":true,"rev":3}'::jsonb, 'the next save chains from the new rev');
reset role;

select is(
  (select count(*)::int from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000a1'), 1,
  'updating app_state wrote one app_state_history snapshot (hourly throttle)');
select is(
  (select data from public.app_state where user_id = '00000000-0000-0000-0000-0000000000b2'), '{"who":"friend"}'::jsonb,
  'the owner''s saves left the friend''s row alone');
select ok(
  (select updated_at > now() - interval '1 minute' from public.app_state where user_id = '00000000-0000-0000-0000-0000000000a1'),
  'save_app_state sets updated_at');

-- ── Allowlisted by a mixed-case row ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"friend@example.com","role":"authenticated"}', true);
select ok(public.is_allowed(), 'is_allowed() matches an allowlist row case-insensitively');
select is((select data ->> 'who' from public.app_state), 'friend', 'friend sees their own row');
reset role;

-- ── Allowlisted, no row yet: the first save inserts one ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d4","email":"newbie@example.com","role":"authenticated"}', true);
select is(public.save_app_state('{"first":true}', 0), '{"ok":true,"rev":1}'::jsonb, 'a first save inserts the row at rev 1');
select is((select data from public.app_state), '{"first":true}'::jsonb, 'the new row holds the saved data');
select is(public.save_app_state('{"again":true}', 0) - 'data', '{"ok":false,"rev":1}'::jsonb, 'a second insert attempt at rev 0 is a conflict');
reset role;

-- ── Signed in, not allowlisted ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","email":"stranger@example.com","role":"authenticated"}', true);
select ok(not public.is_allowed(), 'is_allowed() is false for an email not on the list');
select is((select count(*)::int from public.app_state), 0, 'a non-allowlisted user cannot read even their own row');
select is_empty(
  $q$update public.app_state set data = '{}' where user_id = '00000000-0000-0000-0000-0000000000c3' returning 1$q$,
  'a non-allowlisted user cannot update their own row');
select throws_ok($q$select public.save_app_state('{}', 0)$q$, '42501', null, 'a non-allowlisted user cannot save_app_state');
reset role;
select is(
  (select data from public.app_state where user_id = '00000000-0000-0000-0000-0000000000c3'), '{"who":"stranger"}'::jsonb,
  'the stranger''s row is unchanged');

-- ── Signed out (anon) ──
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from public.demo_snapshot), 1, 'anon can read demo_snapshot');
select throws_ok('select * from public.app_state', '42501', null, 'anon cannot read app_state');
select throws_ok($q$update public.demo_snapshot set data = '{}'$q$, '42501', null, 'anon cannot update demo_snapshot');
select throws_ok('delete from public.demo_snapshot', '42501', null, 'anon cannot delete demo_snapshot');
select throws_ok('truncate public.demo_snapshot', '42501', null, 'anon cannot truncate demo_snapshot');
select throws_ok('select public.is_allowed()', '42501', null, 'anon cannot call is_allowed()');
select throws_ok($q$select public.save_app_state('{}', 0)$q$, '42501', null, 'anon cannot call save_app_state()');
reset role;

-- ── Realtime ──
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_state'),
  'app_state is in the supabase_realtime publication');
select is(
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename <> 'app_state'), 0,
  'no other public table is published to Realtime');

select * from finish();
rollback;
