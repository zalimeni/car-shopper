// Per-user app-state backup snapshots (list + restore).
//
//   GET           — list the caller's snapshots: { snapshots: [{ id, saved_at }] }
//   POST { id }   — restore that snapshot into app_state. The current state is
//                   snapshotted first (explicitly — not relying on the
//                   trigger's hourly throttle), so a restore is itself undoable.
//   POST { photos: [{ vin, url }] } — copy up to 6 dealer photos into the
//                   caller's folder of the private listing-photos bucket
//                   (api/_photos.js) → { stored: [{ vin, key }], failed: [...] }.
//                   The client then sets listing.photoKey; the blob isn't
//                   touched here. (A mode here rather than a new function.)
//
// Snapshots are written automatically by a DB trigger on app_state (see
// supabase/migrations/*_app_state_history.sql). The history table is
// RLS-locked with no client policies, so this endpoint reaches it via the
// service-role client — always scoped to the authenticated caller's user_id.

import { authorize, deny } from "./_auth.js";
import { adminClient } from "./_supabaseAdmin.js";
import { importBlobKeys } from "./_keys.js";
import { storePhotos } from "./_photos.js";

export default async function handler(req, res) {
  const auth = await authorize(req);
  if (auth.error) { deny(res, auth); return; }
  const userId = auth.user.id;

  const db = adminClient();
  if (!db) { res.status(500).json({ error: "Supabase secret key is not configured on the server" }); return; }

  if (req.method === "GET") {
    const { data, error } = await db
      .from("app_state_history")
      .select("id,saved_at")
      .eq("user_id", userId)
      .order("saved_at", { ascending: false })
      .limit(30);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ snapshots: data || [] });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "Use GET or POST" }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  if (Array.isArray(body.photos)) { res.status(200).json(await storePhotos(db, userId, body.photos)); return; }
  const id = Number(body.id);
  if (!id) { res.status(400).json({ error: "Missing snapshot 'id'" }); return; }

  const snap = await db
    .from("app_state_history")
    .select("id,data,saved_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (snap.error) { res.status(500).json({ error: snap.error.message }); return; }
  if (!snap.data) { res.status(404).json({ error: "Snapshot not found" }); return; }

  // Snapshot the CURRENT state before overwriting it, so the restore itself
  // can be undone from the same list.
  const cur = await db.from("app_state").select("data,rev").eq("user_id", userId).maybeSingle();
  if (!cur.error && cur.data && cur.data.data != null) {
    // MarketCheck keys left in an old blob move to the vault first; snapshots
    // never hold them (the trigger strips them the same way).
    await importBlobKeys(userId, cur.data.data.settings);
    await db.from("app_state_history").insert({ user_id: userId, data: withoutBlobKeys(cur.data.data) });
  }

  // Bump rev so any still-open session's compare-and-swap write loses to the
  // restore (it reloads) instead of silently clobbering it.
  const payload = {
    user_id: userId,
    data: withoutBlobKeys(snap.data.data),
    updated_at: new Date().toISOString(),
    rev: ((cur.data && cur.data.rev) || 0) + 1,
  };
  const up = await db.from("app_state").upsert(payload, { onConflict: "user_id" });
  if (up.error) { res.status(500).json({ error: up.error.message }); return; }

  res.status(200).json({ ok: true, restored: snap.data.saved_at });
}

// The blob minus settings.marketcheckKeys (they live in the key vault).
function withoutBlobKeys(d) {
  if (!d || !d.settings || d.settings.marketcheckKeys == null) return d;
  const settings = Object.assign({}, d.settings);
  delete settings.marketcheckKeys;
  return Object.assign({}, d, { settings: settings });
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
