-- pgTAP: the allowlist flags, my_access(), the user_api_keys vault, the
-- snapshot trigger's key scrub, and user deletion. Run with `supabase test db`
-- (CI: .github/workflows/migrations.yml). Everything runs in one transaction
-- that is rolled back at the end. See rls.test.sql for how a check acts as a
-- signed-in user.

begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- ── Fixtures (as postgres, so RLS does not apply) ──
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'friend@example.com'),
  ('00000000-0000-0000-0000-0000000000c3', 'stranger@example.com');
-- Mixed case on purpose: my_access() must match it case-insensitively.
insert into public.allowed_emails (email, is_admin) values ('owner@example.com', true), ('Friend@Example.com', false)
  on conflict (email) do update set is_admin = excluded.is_admin;
insert into public.app_state (user_id, data) values
  ('00000000-0000-0000-0000-0000000000c3', '{"who":"stranger"}');
insert into public.user_api_keys (user_id, provider, position, ciphertext, last4) values
  ('00000000-0000-0000-0000-0000000000a1', 'anthropic', 0, 'v2:opaque', 'abcd'),
  ('00000000-0000-0000-0000-0000000000a1', 'marketcheck', 0, 'v2:opaque', 'wxyz');

select throws_ok(
  $q$insert into public.user_api_keys (user_id, provider, ciphertext) values ('00000000-0000-0000-0000-0000000000a1', 'anthropic', 'x')$q$,
  '23505', null, 'a second Anthropic key for one user is refused');

-- ── Admin ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"owner@example.com","role":"authenticated"}', true);
select ok((select allowed and admin from public.my_access()), 'my_access(): an admin is allowed and admin');
select throws_ok('select * from public.user_api_keys', '42501', null, 'authenticated cannot read user_api_keys, even its own rows');
select throws_ok($q$update public.allowed_emails set is_admin = true$q$, '42501', null, 'authenticated cannot make itself an admin');
reset role;

-- ── Allowlisted, not an admin (email in another letter case) ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"FRIEND@example.com","role":"authenticated"}', true);
select ok((select allowed and not admin from public.my_access()), 'my_access(): an allowlisted non-admin, any letter case');
reset role;

-- ── Not on the list ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","email":"stranger@example.com","role":"authenticated"}', true);
select ok((select not allowed and not admin from public.my_access()), 'my_access(): not on the list');
reset role;

-- ── Signed out ──
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok('select * from public.my_access()', '42501', null, 'anon cannot call my_access()');
select throws_ok('select * from public.user_api_keys', '42501', null, 'anon cannot read user_api_keys');
reset role;

-- ── Snapshots never keep MarketCheck keys from the blob ──
update public.app_state set data = '{"who":"stranger","settings":{"budget":1,"marketcheckKeys":[{"key":"PLAINTEXT"}]}}'
  where user_id = '00000000-0000-0000-0000-0000000000c3';
delete from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3';
update public.app_state set data = '{"who":"stranger"}' where user_id = '00000000-0000-0000-0000-0000000000c3';
select is((select count(*)::int from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3'), 1,
  'the update wrote one snapshot');
select ok((select data #> '{settings,marketcheckKeys}' is null from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3'),
  'the snapshot trigger strips settings.marketcheckKeys');
select is((select data #>> '{settings,budget}' from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3'), '1',
  'and keeps the rest of the settings');

-- ── Deleting a user cascades without tripping the snapshot trigger ──
select lives_ok($q$delete from auth.users where id = '00000000-0000-0000-0000-0000000000c3'$q$, 'deleting a user with app state succeeds');
select ok(
  not exists (select 1 from public.app_state where user_id = '00000000-0000-0000-0000-0000000000c3')
  and not exists (select 1 from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3'),
  'deleting a user removes their app_state and backups');

select * from finish();
rollback;
