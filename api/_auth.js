// Shared server-side auth gate for the /api functions.
//
// Files prefixed with "_" are treated as modules, not routes, by Vercel.
//
// Verifies the caller's Supabase access token (sent as `Authorization: Bearer`)
// and checks the account email against the allowlist. This is the real access
// control: anyone can sign up via Supabase magic-link with any email, so the
// allowlist — not the login — is what protects the MarketCheck key/quota (and
// any future server endpoints). Enforced here, server-side; the client cannot
// bypass it.
//
// Allowlist sources (a user is allowed if EITHER grants access):
//   1. the public.allowed_emails table (see supabase/migrations), read via the
//      is_allowed() RPC — also what RLS uses, so it's the shared source of truth;
//   2. the ALLOWED_EMAILS env var (comma-separated), which always applies and is
//      handy for granting access without a DB write (and works before the
//      migration is applied). Defaults to the owner's email.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://dispkandrvmycwccavvl.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  "sb_publishable_TlJnt8hWo6eeQ1yJV9r0KQ_IbZwbfDk";

const DEFAULT_ALLOW = "mzalimeni@gmail.com";

function envAllowlist() {
  return (process.env.ALLOWED_EMAILS || DEFAULT_ALLOW)
    .split(",")
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

// Returns { user } when the caller is authenticated AND allowlisted, otherwise
// { error, status } (401 unauthenticated, 403 not on the list).
export async function authorize(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = header.indexOf("Bearer ") === 0 ? header.slice(7).trim() : "";
  if (!token) return { error: "Missing authentication token", status: 401 };

  // Client carries the caller's token so getUser() and the is_allowed() RPC both
  // run in that user's context.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return { error: "Invalid or expired session", status: 401 };

  const email = (data.user.email || "").toLowerCase();

  // Allowed if the env list grants it OR the DB allowlist (is_allowed RPC) does.
  let allowed = email !== "" && envAllowlist().indexOf(email) > -1;
  if (!allowed) {
    try {
      const rpc = await supabase.rpc("is_allowed");
      if (!rpc.error && rpc.data === true) allowed = true;
    } catch (e) { /* RPC missing/unreachable — env list already checked */ }
  }

  if (!allowed) return { error: "This account is not authorized to use this app", status: 403 };
  return { user: data.user };
}

