-- pgTAP: TOTP MFA in the database — mfa_ok(), the restrictive app_state and
-- storage.objects policies, and my_access_mfa(). Run with
-- `supabase test db` (CI: .github/workflows/migrations.yml). Everything runs in
-- one transaction that is rolled back at the end. See rls.test.sql for how a
-- check acts as a signed-in user; here the claims also carry `aal`, the way
-- Supabase Auth issues them (aal1 after an email sign-in, aal2 after a code).

begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

-- ── Fixtures (as postgres, so RLS does not apply) ──
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000aa01', 'enrolled@example.com'),
  ('00000000-0000-0000-0000-00000000aa02', 'pending@example.com'),
  ('00000000-0000-0000-0000-00000000aa03', 'plain@example.com');
insert into public.allowed_emails (email) values ('enrolled@example.com'), ('pending@example.com'), ('plain@example.com')
  on conflict do nothing;
insert into public.app_state (user_id, data) values
  ('00000000-0000-0000-0000-00000000aa01', '{"who":"enrolled"}'),
  ('00000000-0000-0000-0000-00000000aa02', '{"who":"pending"}'),
  ('00000000-0000-0000-0000-00000000aa03', '{"who":"plain"}');
-- enrolled: one verified TOTP factor. pending: started enrolling, never
-- verified a code (doesn't count). plain: no factor at all.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000aa01', 'phone', 'totp', 'verified', now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000aa02', 'phone', 'totp', 'unverified', now(), now());

-- ── Policies in place ──
select is(
  (select permissive from pg_policies where schemaname = 'public' and tablename = 'app_state' and policyname = 'app_state_mfa'),
  'RESTRICTIVE', 'app_state has a restrictive MFA policy');
select is(
  (select cmd from pg_policies where schemaname = 'public' and tablename = 'app_state' and policyname = 'app_state_mfa'),
  'ALL', 'it covers every command');
select is(
  (select permissive from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'objects_mfa'),
  'RESTRICTIVE', 'storage.objects has the same restrictive MFA policy');

-- ── Enrolled user, aal1 token (email sign-in only, or a stolen token) ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aa01","email":"enrolled@example.com","role":"authenticated","aal":"aal1"}', true);
select ok(not public.mfa_ok(), 'mfa_ok() is false for aal1 when the user has a verified factor');
select is((select count(*)::int from public.app_state), 0, 'an aal1 token cannot read the enrolled user''s row');
select is_empty(
  $q$update public.app_state set data = '{"hacked":true}' where user_id = '00000000-0000-0000-0000-00000000aa01' returning 1$q$,
  'an aal1 token cannot update it');
select is_empty(
  $q$delete from public.app_state where user_id = '00000000-0000-0000-0000-00000000aa01' returning 1$q$,
  'an aal1 token cannot delete it');
select throws_ok($q$select public.save_app_state('{"hacked":true}', 0)$q$, '42501', null, 'save_app_state() with a rev is refused at aal1');
select throws_ok($q$select public.save_app_state('{"hacked":true}', null)$q$, '42501', null, 'save_app_state() with no rev is refused at aal1');
select ok((select allowed and has_mfa from public.my_access_mfa()), 'my_access_mfa(): allowed, has_mfa');
reset role;
select is((select data from public.app_state where user_id = '00000000-0000-0000-0000-00000000aa01'), '{"who":"enrolled"}'::jsonb,
  'the enrolled user''s row is unchanged after the aal1 attempts');

-- ── Enrolled user, aal2 token (after the code) ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aa01","email":"enrolled@example.com","role":"authenticated","aal":"aal2"}', true);
select ok(public.mfa_ok(), 'mfa_ok() is true at aal2');
select is((select data ->> 'who' from public.app_state), 'enrolled', 'an aal2 token reads the row');
select is(public.save_app_state('{"who":"enrolled","v":1}', 0), '{"ok":true,"rev":1}'::jsonb, 'save_app_state() works at aal2');
select ok((select allowed and has_mfa from public.my_access_mfa()), 'my_access_mfa() still says has_mfa at aal2');
reset role;

-- ── Unverified factor only (enrollment never finished), aal1 ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aa02","email":"pending@example.com","role":"authenticated","aal":"aal1"}', true);
select ok(public.mfa_ok(), 'an unverified factor does not count');
select is((select data ->> 'who' from public.app_state), 'pending', 'so aal1 still reads the row');
select ok((select allowed and not has_mfa from public.my_access_mfa()), 'my_access_mfa(): has_mfa is false');
reset role;

-- ── No factor at all: unaffected ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aa03","email":"plain@example.com","role":"authenticated","aal":"aal1"}', true);
select ok(public.mfa_ok(), 'mfa_ok() is true at aal1 with no factor');
select is((select data ->> 'who' from public.app_state), 'plain', 'a user with no factor reads their row at aal1');
select is(public.save_app_state('{"who":"plain","v":1}', 0), '{"ok":true,"rev":1}'::jsonb, 'and saves');
select is((select count(*)::int from public.app_state), 1, 'and still sees only their own row');
reset role;

-- A token with no aal claim at all reads as aal1.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aa01","email":"enrolled@example.com","role":"authenticated"}', true);
select is((select count(*)::int from public.app_state), 0, 'no aal claim is treated as aal1 for an enrolled user');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aa03","email":"plain@example.com","role":"authenticated"}', true);
select is((select count(*)::int from public.app_state), 1, 'and changes nothing for a user with no factor');
reset role;

-- ── Signed out ──
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok('select public.mfa_ok()', '42501', null, 'anon cannot call mfa_ok()');
select throws_ok('select * from public.my_access_mfa()', '42501', null, 'anon cannot call my_access_mfa()');
reset role;

-- ── Grants and search_path kept ──
select ok(
  (select proconfig @> array['search_path=""'] and prosecdef from pg_proc where oid = 'public.my_access_mfa()'::regprocedure),
  'my_access_mfa() is security definer with an empty search_path');
select ok(
  (select proconfig @> array['search_path=""'] and prosecdef from pg_proc where oid = 'public.mfa_ok()'::regprocedure),
  'mfa_ok() is security definer with an empty search_path');

select * from finish();
rollback;
