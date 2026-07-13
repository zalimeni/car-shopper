// Client for /api/snapshots — list + restore the automatic app-state backups.
// Same session-token pattern as sync.js / admin.js.

import { supabase } from "./supabaseClient";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : "";
  return { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" };
}

export async function listSnapshots() {
  const res = await fetch("/api/snapshots", { headers: await authHeaders() });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
  return j.snapshots || [];
}

export async function restoreSnapshot(id) {
  const res = await fetch("/api/snapshots", { method: "POST", headers: await authHeaders(), body: JSON.stringify({ id: id }) });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
  return j;
}
