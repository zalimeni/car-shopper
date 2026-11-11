// Storage wrapper backed by Supabase.
//
// The whole app state is stored as a single JSONB blob in one row per user
// (table `app_state`, keyed by user_id), behind an async get/set API.
//
// Concurrency: the row carries a monotonic `rev` counter. get() returns it and
// set() takes the expected rev; the save_app_state() database function writes
// only if the stored rev still matches, otherwise the caller gets { conflict }
// with the stored state so it can reload instead of clobbering what another
// device wrote. A null expected rev writes unconditionally.

import { supabase } from "./supabaseClient";
import { DEMO, loadDemo } from "./demoRuntime";

const TABLE = "app_state";

async function currentUserId() {
  // getSession() reads the local session (no network). RLS enforces access
  // regardless, so the session's user id is all we need here.
  const { data } = await supabase.auth.getSession();
  return data && data.session && data.session.user ? data.session.user.id : null;
}

// Demo mode (/?demo): the published snapshot, edited in memory only — nothing
// is ever written to Supabase, and a reload starts the demo over.
const demoStorage = {
  async get(key) {
    const d = await loadDemo();
    if (!d) throw new Error("The demo isn't available right now");
    return { key, value: JSON.stringify(d.data), rev: 0 };
  },
  async set(key, value) { return { key, value, rev: 0 }; },
};

const storage = DEMO ? demoStorage : {
  async get(key) {
    try {
      const userId = await currentUserId();
      if (!userId) return null;
      const { data, error } = await supabase.from(TABLE).select("data,rev").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      if (!data || data.data == null) return null;
      return { key, value: JSON.stringify(data.data), rev: data.rev == null ? 0 : data.rev };
    } catch (e) {
      console.error("storage.get error:", e);
      return null;
    }
  },

  // One save_app_state() call (supabase/migrations/*_save_app_state_and_realtime.sql):
  // the compare-and-swap on rev happens in the database, atomically.
  // Returns { key, value, rev } on success, { conflict: true, key, value, rev }
  // when another device wrote first (value = the stored state), or null on error.
  async set(key, value, expectedRev) {
    try {
      const { data, error } = await supabase.rpc("save_app_state", {
        p_data: JSON.parse(value),
        p_expected_rev: expectedRev == null ? null : expectedRev,
      });
      if (error) throw error;
      if (data && data.ok) return { key, value, rev: data.rev };
      return {
        conflict: true,
        key,
        value: JSON.stringify(data && data.data != null ? data.data : {}),
        rev: data && data.rev != null ? data.rev : 0,
      };
    } catch (e) {
      console.error("storage.set error:", e);
      return null;
    }
  },
};

export default storage;

// Realtime: calls onChange(rev) when this user's app_state row is updated —
// by another device, or by this tab's own save (the caller compares revs).
// rev is null if the payload doesn't carry it (Realtime can trim a large
// record). Resolves to an unsubscribe function. A no-op in demo mode or
// when signed out.
export async function watchState(onChange) {
  if (DEMO) return function () {};
  const userId = await currentUserId();
  if (!userId) return function () {};
  const channel = supabase
    .channel("app_state:" + userId)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: TABLE, filter: "user_id=eq." + userId }, function (payload) {
      const rev = payload && payload.new ? payload.new.rev : null;
      onChange(typeof rev === "number" ? rev : null);
    })
    .subscribe();
  return function () { supabase.removeChannel(channel); };
}
