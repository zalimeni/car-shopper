-- Migration: one atomic save function for app_state, and Realtime on it
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run. Tested in supabase/tests/.
--
-- 1) save_app_state(p_data, p_expected_rev) is the only way the browser
--    writes its state. It does the compare-and-swap on `rev` in one call:
--    - expected rev matches the stored rev: write, rev + 1;
--    - no row yet: insert at expected rev + 1 (a same-moment insert from
--      another device loses with a conflict, not an error);
--    - the stored rev moved on (another device wrote first): nothing is
--      written, and the answer carries the stored rev and data so the client
--      can reload;
--    - expected rev null: write regardless (insert or overwrite), rev + 1.
--    It returns jsonb { ok, rev } or { ok: false, rev, data }.
--    SECURITY INVOKER: it runs as the caller, so the app_state RLS policies
--    (own row, allowlisted) apply to every statement in it. updated_at is set
--    by the database.
-- 2) app_state joins the supabase_realtime publication, so an open session
--    hears about writes from the user's other devices (src/App.jsx). Realtime
--    applies the same RLS policies to each subscriber. Skipped where the
--    publication does not exist (a plain Postgres).

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

  if p_expected_rev is null then
    insert into public.app_state as a (user_id, data, rev, updated_at)
    values (uid, p_data, 1, now())
    on conflict (user_id) do update
      set data = excluded.data, rev = a.rev + 1, updated_at = now()
    returning a.rev into new_rev;
    return jsonb_build_object('ok', true, 'rev', new_rev);
  end if;

  update public.app_state
     set data = p_data, rev = rev + 1, updated_at = now()
   where user_id = uid and rev = p_expected_rev
  returning rev into new_rev;
  if new_rev is not null then
    return jsonb_build_object('ok', true, 'rev', new_rev);
  end if;

  select a.rev, a.data into cur_rev, cur_data from public.app_state a where a.user_id = uid;
  if cur_rev is null then
    -- No row the caller can see. Insert one; RLS rejects a caller who is
    -- not allowlisted (42501), and a row another device inserted a moment
    -- ago makes this a no-op, reported as a conflict below.
    insert into public.app_state (user_id, data, rev, updated_at)
    values (uid, p_data, p_expected_rev + 1, now())
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

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_state'
     ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end $$;
