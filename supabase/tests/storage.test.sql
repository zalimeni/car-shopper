-- pgTAP: the listing-photos Storage bucket and its RLS on storage.objects
-- (supabase/migrations/*_listing_photos.sql), checked as the roles the
-- Storage API uses. Run with `supabase test db`. One transaction, rolled back.
--
-- Deletes aren't exercised with SQL (Storage blocks direct deletes on its
-- tables); the delete policy's shape is checked instead.

begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- ── Fixtures (as postgres, so RLS does not apply) ──
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000f0a1', 'photo-owner@example.com'),
  ('00000000-0000-0000-0000-00000000f0b2', 'photo-friend@example.com'),
  ('00000000-0000-0000-0000-00000000f0c3', 'photo-stranger@example.com');
insert into public.allowed_emails (email) values ('photo-owner@example.com'), ('photo-friend@example.com')
  on conflict do nothing;
insert into storage.objects (bucket_id, name, owner) values
  ('listing-photos', '00000000-0000-0000-0000-00000000f0a1/1HGCM82633A004352.jpg', null),
  ('listing-photos', '00000000-0000-0000-0000-00000000f0b2/2T3RWRFV5LW000001.webp', null),
  ('listing-photos', '00000000-0000-0000-0000-00000000f0c3/JTMDJREV0HD000002.png', null);

-- ── The bucket ──
select is((select public from storage.buckets where id = 'listing-photos'), false, 'listing-photos is a private bucket');
select is((select file_size_limit::bigint from storage.buckets where id = 'listing-photos'), 2097152::bigint, 'listing-photos caps objects at 2 MB');
select ok(
  (select bool_and(m like 'image/%') and count(*) > 0 from storage.buckets b, unnest(b.allowed_mime_types) m where b.id = 'listing-photos'),
  'listing-photos accepts image types only');

-- ── Allowlisted owner ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f0a1","email":"photo-owner@example.com","role":"authenticated"}', true);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'listing-photos'), 1,
  'the owner sees exactly one photo');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'listing-photos' and name like '00000000-0000-0000-0000-00000000f0b2/%'), 0,
  'the owner cannot see another user''s photos');
select throws_ok(
  $q$insert into storage.objects (bucket_id, name) values ('listing-photos', '00000000-0000-0000-0000-00000000f0a1/X1.jpg')$q$,
  '42501', null, 'the owner cannot write objects (the server uploads)');
select is_empty(
  $q$update storage.objects set name = name where bucket_id = 'listing-photos' returning 1$q$,
  'the owner cannot update objects');
reset role;

-- ── Signed in, not allowlisted (has a folder anyway) ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f0c3","email":"photo-stranger@example.com","role":"authenticated"}', true);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'listing-photos'), 0,
  'a non-allowlisted user cannot read even their own folder');
reset role;

-- ── Signed out (anon) ──
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'listing-photos'), 0,
  'anon sees no photos');
reset role;

-- ── Policy shape ──
select policy_cmd_is('storage', 'objects', 'listing_photos_delete_own', 'delete', 'the delete policy is for DELETE');
select policy_roles_are('storage', 'objects', 'listing_photos_delete_own', array['authenticated'], 'only signed-in users may delete (their own folder)');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and cmd in ('INSERT', 'UPDATE', 'ALL')
     and coalesce(qual, '') || coalesce(with_check, '') like '%listing-photos%'),
  0, 'no client policy lets anyone write listing-photos');

select * from finish();
rollback;
