// The one place the browser turns its Supabase session into /api request
// headers. Every client module (score, keys, admin, snapshots, sync, photos,
// the demo publisher) calls authHeaders() instead of keeping its own copy.

import { supabase } from "./supabaseClient";

// The current access token, or "" when signed out. getSession() reads the
// local session (no network).
export async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data && data.session && data.session.access_token ? data.session.access_token : "";
}

// JSON + Bearer headers for an /api call (Authorization "" when signed out —
// the server answers 401).
export async function authHeaders() {
  const token = await accessToken();
  return { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" };
}
