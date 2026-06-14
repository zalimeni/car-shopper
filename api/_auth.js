// Shared server-side auth gate for the /api functions.
//
// Files prefixed with "_" are treated as modules, not routes, by Vercel.
//
// Verifies the caller's Supabase access token (sent as `Authorization: Bearer`)
// and checks the account email against an allowlist. This is the real access
// control: anyone can sign up via Supabase magic-link with any email, so the
// allowlist — not the login — is what protects the MarketCheck key/quota (and
// any future server endpoints). Enforced here, server-side; the client cannot
// bypass it.
//
// Allowlist source: ALLOWED_EMAILS (comma-separated) env var, defaulting to the
// owner's email. Set it in Vercel to grant additional accounts.

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

function allowedEmails() {
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return { error: "Invalid or expired session", status: 401 };

  const email = (data.user.email || "").toLowerCase();
  if (!email || allowedEmails().indexOf(email) === -1) {
    return { error: "This account is not authorized to use this app", status: 403 };
  }
  return { user: data.user };
}
