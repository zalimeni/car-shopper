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

rollback;
