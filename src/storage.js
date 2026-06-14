// Storage wrapper backed by Supabase.
//
// The whole app state is stored as a single JSONB blob in one row per user
// (table `app_state`, keyed by user_id). The async get/set/delete API matches
// the previous localStorage wrapper so the rest of the app is unchanged.
//
// On first read for a user, any data left in localStorage from the old
// localStorage-only version is migrated up to Supabase, then cleared.

import { supabase } from "./supabaseClient";

const TABLE = "app_state";
const LEGACY_KEY = "car-search-data";

async function currentUserId() {
  const { data } = await supabase.auth.getUser();
  return data && data.user ? data.user.id : null;
}

const storage = {
  async get(key) {
    try {
      const userId = await currentUserId();
      if (!userId) return null;

      const { data, error } = await supabase
        .from(TABLE)
        .select("data")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;

      if (data && data.data != null) {
        return { key, value: JSON.stringify(data.data) };
      }

      // No remote row yet — migrate legacy localStorage data if present.
      try {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy && legacy !== "undefined") {
          await this.set(key, legacy);
          localStorage.removeItem(LEGACY_KEY);
          return { key, value: legacy };
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

  async set(key, value) {
    try {
      const userId = await currentUserId();
      if (!userId) return null;

      const { error } = await supabase.from(TABLE).upsert(
        {
          user_id: userId,
          data: JSON.parse(value),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return { key, value };
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
