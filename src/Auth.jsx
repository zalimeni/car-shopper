import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

// Gates the app behind Supabase email auth (magic link or one-time code). Renders a sign-in
// screen until there's a session, then renders children. Signing in with the
// same email on any device gives you the same synced data.
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(null); // null = checking | true | false

  useEffect(() => {
    // Resolve the initial auth state from whichever of these fires first:
    //  - getSession() (local read), or
    //  - onAuthStateChange's INITIAL_SESSION event (fires even when the
    //    getSession() promise stalls — e.g. the auth client wedges while
    //    exchanging the URL session right after a magic-link redirect), or
    //  - a timeout backstop, so the app can never sit on "Loading…" forever.
    let settled = false;
    const finish = (s) => {
      setSession(s);
      if (!settled) { settled = true; setLoading(false); }
    };
    supabase.auth.getSession().then(({ data }) => finish(data.session)).catch(() => finish(null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => finish(s));
    const timer = setTimeout(() => { if (!settled) { settled = true; setLoading(false); } }, 8000);
    return () => { clearTimeout(timer); sub.subscription.unsubscribe(); };
  }, []);

  // Ask the server whether this account is on the allowlist (env OR DB). This is
  // a UX gate only — the data layer (RLS) and the API enforce access regardless —
  // so on any error (offline, local dev without functions) we fail open and let
  // the app render; non-allowlisted users simply see empty data + 403 on sync.
  //
  // Keyed on the user id (not the whole session) so routine token refreshes —
  // which fire on every mobile app-switch/focus — don't re-run this and unmount
  // the app. We only blank to "Checking access…" on the FIRST check; later
  // identity changes re-verify in the background without tearing down the app.
  const userId = session && session.user ? session.user.id : null;
  useEffect(() => {
    if (!userId) { setAuthorized(null); return; }
    let cancelled = false;
    // Fail open if the check stalls, so a hung request can't wedge the app on
    // "Checking access…" indefinitely.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    (async () => {
      try {
        // Use the token already in state — re-calling getSession() here can
        // stall for the same reason and wedge the app on "Checking access…".
        const token = session && session.access_token ? session.access_token : "";
        const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + token }, signal: ac.signal });
        if (cancelled) return;
        if (res.status === 403) { setAuthorized(false); return; }
        if (res.ok) {
          const j = await res.json().catch(() => null);
          setAuthorized(!(j && j.authorized === false));
          return;
        }
        setAuthorized(true); // 401/other -> fail open
      } catch (e) {
        if (!cancelled) setAuthorized(true); // network / timeout / local dev -> fail open
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); ac.abort(); };
  }, [userId]);

  if (loading) return <div style={S.center}>Loading…</div>;
  if (!session) return <SignIn />;
  if (authorized === null) return <div style={S.center}>Checking access…</div>;
  if (authorized === false) return <NotAuthorized email={session.user && session.user.email} />;
  return children;
}

function NotAuthorized({ email }) {
  return (
    <div style={S.center}>
      <div style={S.card}>
        <h1 style={S.title}>Access not enabled</h1>
        <p style={S.sub}>
          {email ? "The account " : "This account "}
          {email && <strong>{email}</strong>}
          {email ? " isn’t on the allowlist for this app." : " isn’t on the allowlist for this app."}
        </p>
        <p style={{ ...S.sub, marginTop: 0 }}>
          If you think this is a mistake, ask the owner to add you, then sign in again.
        </p>
        <button style={S.button} onClick={() => signOut()}>Sign out</button>
      </div>
    </div>
  );
}

// Two ways in from one email: the link (opens in the browser) or the code typed
// here. The code matters on an iPhone Home Screen web app — it has its own
// storage, separate from Safari, and email links always open in Safari, so the
// link would sign Safari in and leave the Home Screen app signed out. Typing the
// code signs in whichever window it's typed into. (The Supabase "Magic Link"
// email template must include {{ .Token }} — see supabase/templates/.)
function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false); // email sent -> show the code step
  const [status, setStatus] = useState("idle"); // idle | sending | verifying | error
  const [error, setError] = useState("");

  async function send(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setError("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      setError(error.message);
      setStatus("error");
    } else {
      setSent(true);
      setStatus("idle");
    }
  }

  async function verify(e) {
    e.preventDefault();
    const token = code.replace(/\s+/g, "");
    if (!token) return;
    setStatus("verifying");
    setError("");
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: token, type: "email" });
    // On success onAuthStateChange swaps this screen for the app.
    if (error) {
      setError(/expired|invalid/i.test(error.message) ? "That code didn't work — it may have expired. Check you used the newest email, or send a new one." : error.message);
      setStatus("error");
    }
  }

  return (
    <div style={S.center}>
      <div style={S.card}>
        <h1 style={S.title}>Car Shopper</h1>
        <p style={S.sub}>Sign in to load your synced data.</p>
        {sent ? (
          <form onSubmit={verify}>
            <p style={S.sent}>
              We emailed <strong>{email}</strong> a sign-in link and a code. Tap the link, or type the code here
              {isStandalone() ? " (the link would open in Safari, not this app)" : ""}:
            </p>
            <input
              style={Object.assign({}, S.input, S.code)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
              aria-label="Sign-in code"
            />
            <button style={S.button} type="submit" disabled={status === "verifying" || code.length < 6}>
              {status === "verifying" ? "Signing in…" : "Sign in with code"}
            </button>
            <button type="button" style={S.link} onClick={() => { setSent(false); setStatus("idle"); setCode(""); setError(""); }}>
              Use a different email or send a new code
            </button>
          </form>
        ) : (
          <form onSubmit={send}>
            <input
              style={S.input}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button style={S.button} type="submit" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Email me a sign-in link & code"}
            </button>
          </form>
        )}
        {status === "error" && <p style={S.error}>{error}</p>}
      </div>
    </div>
  );
}

// Running as an installed Home Screen web app (not a Safari tab)?
function isStandalone() {
  try {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  } catch (e) { return false; }
}

export async function signOut() {
  await supabase.auth.signOut();
}

const S = {
  center: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0f1114",
    color: "#e4e4e7",
    fontFamily: "'IBM Plex Sans','SF Pro Text',-apple-system,sans-serif",
    padding: 16,
  },
  card: {
    background: "#161820",
    border: "1px solid #1e2028",
    borderRadius: 12,
    padding: 24,
    width: "100%",
    maxWidth: 360,
  },
  title: { fontSize: 20, fontWeight: 600, margin: 0, color: "#f0f0f3", letterSpacing: "-0.02em" },
  sub: { fontSize: 13, color: "#6b6b76", margin: "6px 0 16px" },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: "#1a1c22",
    border: "1px solid #2a2d38",
    borderRadius: 6,
    color: "#e4e4e7",
    padding: "10px 12px",
    fontSize: 14,
    marginBottom: 10,
    fontFamily: "inherit",
  },
  button: {
    width: "100%",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  sent: { fontSize: 14, color: "#2d8659", lineHeight: 1.6, marginTop: 0 },
  code: { fontSize: 22, letterSpacing: "0.3em", textAlign: "center", fontFamily: "'IBM Plex Mono',monospace" },
  link: { background: "none", border: "none", color: "#6b9bf2", fontSize: 12, marginTop: 10, padding: 0, cursor: "pointer", fontFamily: "inherit" },
  error: { fontSize: 13, color: "#c44", marginTop: 10 },
};
