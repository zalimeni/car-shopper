-- Migration: private Storage bucket for listing photos
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/tests/storage.test.sql.
--
-- A watchlist car's dealer photo is a hotlinked URL that dies when the car
-- sells or is relisted. The server (api/_photos.js) copies it into this bucket
-- at `<user_id>/<VIN>.<ext>` and the listing keeps the path as `photoKey`.
--
--  - Private bucket (no public URLs), 2 MB per object, image types only.
--  - Writes (upload) and the daily orphan sweep use the service role, which
--    bypasses RLS — so there is deliberately NO insert/update policy.
--  - An allowlisted, signed-in user may read (signed URLs) and delete only the
--    objects in their own folder. anon gets nothing.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-photos', 'listing-photos', false, 2097152,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "listing_photos_select_own" on storage.objects;
create policy "listing_photos_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'listing-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_allowed())
  );

drop policy if exists "listing_photos_delete_own" on storage.objects;
create policy "listing_photos_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'listing-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_allowed())
  );
