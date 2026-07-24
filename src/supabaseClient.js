import { createClient, processLock } from "@supabase/supabase-js";
import { diag } from "./loadDiag";

// Wrap fetch so no Supabase request (auth token refresh, DB read) can hang
// forever — the auth client wedges on getSession() when its init-time network
// call never returns. Times out at 12s and logs each request, which also
// reveals (via the load stages) exactly which request stalls.
function csFetch(input, init) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const tag = url.replace(/^https?:\/\/[^/]+/, "").replace(/[?].*$/, "").slice(0, 48) || "req";
  diag("net:START " + tag);
  const ac = new AbortController();
  const to = setTimeout(function () { diag("net:TIMEOUT " + tag); ac.abort(); }, 12000);
  if (init && init.signal) {
    if (init.signal.aborted) ac.abort();
    else init.signal.addEventListener("abort", function () { ac.abort(); });
  }
  return fetch(input, Object.assign({}, init, { signal: ac.signal }))
    .then(function (r) { diag("net:DONE " + r.status + " " + tag); return r; })
    .catch(function (e) { diag("net:ERR " + tag + " " + (e && e.name)); throw e; })
    .finally(function () { clearTimeout(to); });
}

// The Supabase URL and publishable ("anon") key are safe to expose in the
// browser — data access is protected by Row Level Security, not by hiding
// these values. They can be overridden per-environment via VITE_ env vars
// (see .env.example); the defaults below point at the project's instance so
// the deployed app works without extra configuration.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://dispkandrvmycwccavvl.supabase.co";
const SUPABASE_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "sb_publishable_TlJnt8hWo6eeQ1yJV9r0KQ_IbZwbfDk";

// flowType "implicit": magic-link tokens arrive in the URL hash, so sign-in
// works even when the link is opened in a fresh context (private/incognito tab,
// or a different browser than where it was requested). The default PKCE flow
// needs a code verifier stashed in the requesting tab's storage — absent in a
// fresh tab — which left the auth client wedged and the app hung on load.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    flowType: "implicit",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
    // Use the in-memory lock instead of the default Web Locks (navigator.locks)
    // lock. The default can DEADLOCK across tabs — a lock held by another
    // (possibly backgrounded/dead) tab makes getSession()/getUser() hang
    // forever, which stuck an already-authenticated tab on "Loading…" on
    // reload. processLock serializes auth calls within this tab without the
    // cross-tab lock that wedges.
    lock: processLock,
  },
  global: { fetch: csFetch },
});
