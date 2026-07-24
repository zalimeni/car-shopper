// Storage wrapper backed by Supabase.
//
// The whole app state is stored as a single JSONB blob in one row per user
// (table `app_state`, keyed by user_id). The async get/set/delete API matches
// the previous localStorage wrapper so the rest of the app is unchanged.
//
// Concurrency: the row carries a monotonic `rev` counter. get() returns it and
// set() takes the expected rev, writing compare-and-swap style — the update
// only applies if the stored rev still matches, otherwise the caller gets
// { conflict } with the remote state so it can reload instead of clobbering
// what another device wrote. Passing a null/undefined rev (or running before
// the rev migration is applied) degrades to the old last-write-wins upsert.
//
// On first read for a user, any data left in localStorage from the old
// localStorage-only version is migrated up to Supabase, then cleared.

import { supabase, storedSession } from "./supabaseClient";
import { diag } from "./loadDiag";

const TABLE = "app_state";
const LEGACY_KEY = "car-search-data";

async function currentUserId() {
  // Prefer the session read straight from localStorage — supabase-js's
  // getSession() awaits its init, which can hang retrying a failing token
  // refresh. RLS enforces access regardless, so the local session id suffices.
  const stored = storedSession();
  if (stored && stored.user) return stored.user.id;
  const { data } = await supabase.auth.getSession();
  return data && data.session && data.session.user ? data.session.user.id : null;
}

// True when the error is "the rev column doesn't exist yet" — the brief window
// where new client code runs against a database the migration hasn't reached.
function missingRevColumn(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = String(error.message || "");
  return code === "42703" || code === "PGRST204" || /'rev' column/i.test(msg);
}

const storage = {
  async get(key) {
    try {
      diag("storage:getSession-for-userid");
      const userId = await currentUserId();
      diag("storage:userid=" + (userId ? "ok" : "none"));
      if (!userId) return null;

      diag("storage:select-app_state-start");
      let { data, error } = await supabase
        .from(TABLE)
        .select("data,rev")
        .eq("user_id", userId)
        .maybeSingle();
      diag("storage:select-done" + (error ? " ERR:" + (error.code || error.message) : ""));
      if (error && missingRevColumn(error)) {
        ({ data, error } = await supabase.from(TABLE).select("data").eq("user_id", userId).maybeSingle());
      }
      if (error) throw error;

      if (data && data.data != null) {
        return { key, value: JSON.stringify(data.data), rev: data.rev == null ? 0 : data.rev };
      }

      // No remote row yet — migrate legacy localStorage data if present.
      try {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy && legacy !== "undefined") {
          await this.set(key, legacy);
          localStorage.removeItem(LEGACY_KEY);
          return { key, value: legacy, rev: 0 };
        }
      } catch (e) {
        // localStorage may be unavailable; ignore migration in that case.
      }

      return null;
    } catch (e) {
      console.error("storage.get error:", e);
      return null;
    }
  },

  // Returns { key, value, rev } on success (rev null on the legacy path),
  // { conflict: true, value, rev } when another device wrote first, or null on
  // error (matching the old behavior).
  async set(key, value, expectedRev) {
    try {
      const userId = await currentUserId();
      if (!userId) return null;

      const payload = {
        user_id: userId,
        data: JSON.parse(value),
        updated_at: new Date().toISOString(),
      };

      // Unknown rev (first-ever write, degraded init) — old last-write-wins path.
      if (expectedRev == null) {
        const { error } = await supabase.from(TABLE).upsert(payload, { onConflict: "user_id" });
        if (error) throw error;
        return { key, value, rev: null };
      }

      // Compare-and-swap: only applies if nobody else bumped rev since we read.
      const { data, error } = await supabase
        .from(TABLE)
        .update(Object.assign({}, payload, { rev: expectedRev + 1 }))
        .eq("user_id", userId)
        .eq("rev", expectedRev)
        .select("rev");
      if (error) {
        if (missingRevColumn(error)) {
          const up = await supabase.from(TABLE).upsert(payload, { onConflict: "user_id" });
          if (up.error) throw up.error;
          return { key, value, rev: null };
        }
        throw error;
      }
      if (data && data.length) return { key, value, rev: data[0].rev };

      // Zero rows updated: either no row exists yet (insert), or the stored rev
      // moved on (another device wrote) — report the conflict with remote state.
      const cur = await supabase.from(TABLE).select("data,rev").eq("user_id", userId).maybeSingle();
      if (cur.error) throw cur.error;
      if (!cur.data) {
        const ins = await supabase.from(TABLE).insert(Object.assign({}, payload, { rev: expectedRev + 1 }));
        if (ins.error) throw ins.error; // incl. a same-moment insert race — next save retries
        return { key, value, rev: expectedRev + 1 };
      }
      return {
        conflict: true,
        key,
        value: JSON.stringify(cur.data.data),
        rev: cur.data.rev == null ? 0 : cur.data.rev,
      };
    } catch (e) {
      console.error("storage.set error:", e);
      return null;
    }
  },

  async delete() {
    try {
      const userId = await currentUserId();
      if (!userId) return null;

      const { error } = await supabase.from(TABLE).delete().eq("user_id", userId);
      if (error) throw error;
      return { deleted: true };
    } catch (e) {
      console.error("storage.delete error:", e);
      return null;
    }
  },
};

export default storage;
