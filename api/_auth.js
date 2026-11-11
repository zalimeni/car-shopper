// Shared server-side auth gate for the /api functions.
//
// Files prefixed with "_" are treated as modules, not routes, by Vercel.
//
// Verifies the caller's Supabase access token (sent as `Authorization: Bearer`)
// and checks the account against the allowlist, public.allowed_emails (the one
// source of truth — RLS on app_state reads the same table through
// is_allowed()). Sign-up is invite-only (the project has sign-ups turned off
// and the app never creates users), so only invited people have accounts; the
// allowlist still decides who may use the API, and also who is an admin.
// Enforced here, server-side; the client cannot bypass it.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./_supabaseAdmin.js";

// Constant-time string compare (avoids leaking a secret via timing).
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns { user, admin } when the caller is authenticated AND allowlisted,
// otherwise { error, status } (401 unauthenticated, 403 not on the list).
export async function authorize(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = header.indexOf("Bearer ") === 0 ? header.slice(7).trim() : "";
  if (!token) return { error: "Missing authentication token", status: 401 };

  // Client carries the caller's token so getUser() and the my_access() RPC both
  // run in that user's context.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return { error: "Invalid or expired session", status: 401 };

  // One call answers both questions: on the allowlist? an admin?
  let access = null;
  try {
    const rpc = await supabase.rpc("my_access");
    if (!rpc.error) access = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  } catch (e) { /* unreachable — treated as not allowed */ }

  if (!access || !access.allowed) return { error: "This account is not authorized to use this app", status: 403 };
  return { user: data.user, admin: !!access.admin };
}
