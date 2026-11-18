-- Migration: save_app_state() never overwrites without a matching rev
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Checked in CI by supabase/tests/rls.test.sql.
--
-- 20261110120000_save_app_state_and_realtime.sql let a null expected rev
-- write regardless (insert or overwrite). The app always sends a rev (0 for a
-- brand-new user with no row yet), so that branch could only ever clobber
-- another device's write. Now:
--   - expected rev matches the stored rev: write, rev + 1 (unchanged);
--   - no row yet: insert at expected rev + 1 (unchanged; a null rev inserts
--     at 1);
--   - otherwise, including a null rev when a row exists: nothing is written,
--     and the answer carries the stored rev and data (a conflict).
-- Same signature, grants, SECURITY INVOKER and RLS as before (the scheduled
-- sync and backup restore write with the service role, not through here).

create or replace function public.save_app_state(p_data jsonb, p_expected_rev bigint default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  new_rev bigint;
  cur_rev bigint;
  cur_data jsonb;
begin
  if uid is null then
    raise exception 'save_app_state: not signed in' using errcode = '42501';
  end if;
  if p_data is null then
    raise exception 'save_app_state: p_data is required' using errcode = '22004';
  end if;

  if p_expected_rev is not null then
    update public.app_state
       set data = p_data, rev = rev + 1, updated_at = now()
     where user_id = uid and rev = p_expected_rev
    returning rev into new_rev;
    if new_rev is not null then
      return jsonb_build_object('ok', true, 'rev', new_rev);
    end if;
  end if;

  select a.rev, a.data into cur_rev, cur_data from public.app_state a where a.user_id = uid;
  if cur_rev is null then
    -- No row the caller can see. Insert one; RLS rejects a caller who is
    -- not allowlisted (42501), and a row another device inserted a moment
    -- ago makes this a no-op, reported as a conflict below.
    insert into public.app_state (user_id, data, rev, updated_at)
    values (uid, p_data, coalesce(p_expected_rev, 0) + 1, now())
    on conflict (user_id) do nothing
    returning rev into new_rev;
    if new_rev is not null then
      return jsonb_build_object('ok', true, 'rev', new_rev);
    end if;
    select a.rev, a.data into cur_rev, cur_data from public.app_state a where a.user_id = uid;
  end if;

  return jsonb_build_object('ok', false, 'rev', cur_rev, 'data', cur_data);
end;
$$;

revoke all on function public.save_app_state(jsonb, bigint) from public, anon;
grant execute on function public.save_app_state(jsonb, bigint) to authenticated;
