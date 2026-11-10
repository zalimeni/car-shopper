-- CI-only: checks the RLS policies and grants the migrations set up, as the
-- roles the Supabase Data API uses (anon, authenticated). Run after
-- ci/shim.sql and every migration; any failed check raises an exception and
-- stops psql (ON_ERROR_STOP). Plain SQL, so it runs on any Postgres without
-- pgTAP. Everything runs in one transaction that is rolled back at the end.
--
-- To act as a signed-in user, a check sets the role and the JWT claims, the
-- same way PostgREST does for each request:
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"…","email":"…"}', true);

\set ON_ERROR_STOP 1
begin;

-- ── Fixtures (as the migration owner, so RLS does not apply) ──
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'friend@example.com'),
  ('00000000-0000-0000-0000-0000000000c3', 'stranger@example.com');
-- Mixed case on purpose: is_allowed() must match it case-insensitively.
insert into public.allowed_emails (email) values ('owner@example.com'), ('Friend@Example.com');
insert into public.app_state (user_id, data) values
  ('00000000-0000-0000-0000-0000000000a1', '{"who":"owner"}'),
  ('00000000-0000-0000-0000-0000000000b2', '{"who":"friend"}'),
  ('00000000-0000-0000-0000-0000000000c3', '{"who":"stranger"}');
insert into public.user_anthropic_keys (user_id, ciphertext, last4)
  values ('00000000-0000-0000-0000-0000000000a1', 'opaque', 'abcd');
insert into public.demo_snapshot (id, data) values (1, '{"demo":true}')
  on conflict (id) do update set data = excluded.data;

-- Expect `sql` to fail with insufficient_privilege (42501): a missing grant
-- or an RLS WITH CHECK violation.
create function pg_temp.expect_denied(sql text, label text) returns void
language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: % — expected permission denied, but it ran', label;
exception when insufficient_privilege then
  raise notice 'ok: % (denied)', label;
end $$;
grant execute on function pg_temp.expect_denied(text, text) to anon, authenticated;

create function pg_temp.expect(ok boolean, label text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'ok: %', label;
end $$;
grant execute on function pg_temp.expect(boolean, text) to anon, authenticated;

-- ── Allowlisted owner ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"owner@example.com","role":"authenticated"}', true);

select pg_temp.expect(public.is_allowed(), 'is_allowed() is true for an allowlisted email');
select pg_temp.expect((select count(*) from public.app_state) = 1, 'owner sees exactly one app_state row');
select pg_temp.expect((select data ->> 'who' from public.app_state) = 'owner', 'that row is the owner''s own');

update public.app_state set data = '{"who":"owner","edited":true}'
  where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.expect((select (data ->> 'edited')::boolean from public.app_state) is true, 'owner can update their own row');

with hit as (
  update public.app_state set data = '{"hacked":true}'
  where user_id = '00000000-0000-0000-0000-0000000000b2' returning 1
) select pg_temp.expect((select count(*) from hit) = 0, 'owner cannot update another user''s row');

with hit as (
  delete from public.app_state where user_id = '00000000-0000-0000-0000-0000000000b2' returning 1
) select pg_temp.expect((select count(*) from hit) = 0, 'owner cannot delete another user''s row');

select pg_temp.expect_denied(
  $q$insert into public.app_state (user_id, data) values ('00000000-0000-0000-0000-0000000000d4', '{}')$q$,
  'owner cannot insert a row for another user id');

select pg_temp.expect_denied('select * from public.allowed_emails', 'authenticated cannot read allowed_emails');
select pg_temp.expect_denied('select * from public.user_anthropic_keys', 'authenticated cannot read user_anthropic_keys');
select pg_temp.expect_denied('select * from public.app_state_history', 'authenticated cannot read app_state_history');
select pg_temp.expect_denied($q$insert into public.allowed_emails (email) values ('me@example.com')$q$, 'authenticated cannot add itself to allowed_emails');
select pg_temp.expect_denied($q$update public.demo_snapshot set data = '{}'$q$, 'authenticated cannot write demo_snapshot');
select pg_temp.expect_denied('truncate public.app_state', 'authenticated cannot truncate app_state');
select pg_temp.expect((select count(*) from public.demo_snapshot) = 1, 'authenticated can read demo_snapshot');
reset role;

-- The owner's update fired the snapshot trigger (it writes as its definer).
select pg_temp.expect(
  (select count(*) from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000a1') = 1,
  'updating app_state wrote one app_state_history snapshot');

-- ── Allowlisted by a mixed-case row ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"friend@example.com","role":"authenticated"}', true);
select pg_temp.expect(public.is_allowed(), 'is_allowed() matches an allowlist row case-insensitively');
select pg_temp.expect((select data ->> 'who' from public.app_state) = 'friend', 'friend sees their own row');
reset role;

-- ── Signed in, not allowlisted ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","email":"stranger@example.com","role":"authenticated"}', true);
select pg_temp.expect(not public.is_allowed(), 'is_allowed() is false for an email not on the list');
select pg_temp.expect((select count(*) from public.app_state) = 0, 'a non-allowlisted user cannot read even their own row');
with hit as (
  update public.app_state set data = '{}' where user_id = '00000000-0000-0000-0000-0000000000c3' returning 1
) select pg_temp.expect((select count(*) from hit) = 0, 'a non-allowlisted user cannot update their own row');
reset role;

-- ── Signed out (anon) ──
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.expect((select count(*) from public.demo_snapshot) = 1, 'anon can read demo_snapshot');
select pg_temp.expect_denied('select * from public.app_state', 'anon cannot read app_state');
select pg_temp.expect_denied($q$update public.demo_snapshot set data = '{}'$q$, 'anon cannot update demo_snapshot');
select pg_temp.expect_denied('delete from public.demo_snapshot', 'anon cannot delete demo_snapshot');
select pg_temp.expect_denied('truncate public.demo_snapshot', 'anon cannot truncate demo_snapshot');
select pg_temp.expect_denied('select public.is_allowed()', 'anon cannot call is_allowed()');
reset role;

-- ── Allowlist flags, my_access(), the key vault (20261110120000) ──
update public.allowed_emails set is_admin = true where email = 'owner@example.com';
insert into public.user_api_keys (user_id, provider, position, ciphertext, last4) values
  ('00000000-0000-0000-0000-0000000000a1', 'anthropic', 0, 'v2:opaque', 'abcd'),
  ('00000000-0000-0000-0000-0000000000a1', 'marketcheck', 0, 'v2:opaque', 'wxyz');

do $$
begin
  insert into public.user_api_keys (user_id, provider, ciphertext) values ('00000000-0000-0000-0000-0000000000a1', 'anthropic', 'x');
  raise exception 'FAIL: a second Anthropic key for one user was accepted';
exception when unique_violation then
  raise notice 'ok: a second Anthropic key for one user is refused';
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"owner@example.com","role":"authenticated"}', true);
select pg_temp.expect((select allowed and admin from public.my_access()), 'my_access(): an admin is allowed and admin');
select pg_temp.expect_denied('select * from public.user_api_keys', 'authenticated cannot read user_api_keys, even its own rows');
select pg_temp.expect_denied($q$update public.allowed_emails set is_admin = true$q$, 'authenticated cannot make itself an admin');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","email":"FRIEND@example.com","role":"authenticated"}', true);
select pg_temp.expect((select allowed and not admin from public.my_access()), 'my_access(): an allowlisted non-admin (any letter case)');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","email":"stranger@example.com","role":"authenticated"}', true);
select pg_temp.expect((select not allowed and not admin from public.my_access()), 'my_access(): not on the list');
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.expect_denied('select * from public.my_access()', 'anon cannot call my_access()');
select pg_temp.expect_denied('select * from public.user_api_keys', 'anon cannot read user_api_keys');
reset role;

-- Snapshots never keep MarketCheck keys from the blob.
update public.app_state set data = '{"who":"stranger","settings":{"budget":1,"marketcheckKeys":[{"key":"PLAINTEXT"}]}}'
  where user_id = '00000000-0000-0000-0000-0000000000c3';
delete from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3';
update public.app_state set data = '{"who":"stranger"}' where user_id = '00000000-0000-0000-0000-0000000000c3';
select pg_temp.expect(
  (select count(*) = 1 and bool_and(data #> '{settings,marketcheckKeys}' is null and (data #>> '{settings,budget}') = '1')
   from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3'),
  'the snapshot trigger strips settings.marketcheckKeys and keeps the rest');

-- Deleting a user cascades through app_state without tripping the trigger.
delete from auth.users where id = '00000000-0000-0000-0000-0000000000c3';
select pg_temp.expect(
  not exists (select 1 from public.app_state where user_id = '00000000-0000-0000-0000-0000000000c3')
  and not exists (select 1 from public.app_state_history where user_id = '00000000-0000-0000-0000-0000000000c3'),
  'deleting a user removes their app_state and backups');

rollback;
