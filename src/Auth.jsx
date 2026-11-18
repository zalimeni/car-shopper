import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { parseSignInLink } from "./authLink";
import { needsStepUp, isAal2, verifyStepUp, friendlyMfaError, MFA_REQUIRED } from "./mfa";

// Gates the app behind Supabase email auth (a magic link, tapped or pasted).
// Renders a sign-in screen until there's a session, then renders children.
// Signing in with the same email on any device gives you the same synced data.
// `children` may be a function: it gets the /api/me answer (identity, admin
// flag, key metadata — {} when the check failed open), so the app needn't ask
// again on load.
//
// Invite-only: the app never creates accounts (shouldCreateUser: false, and the
// project has sign-ups turned off). An admin invites people from the Admin tab.
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(null); // null = checking | true | false
  const [me, setMe] = useState(null); // the /api/me answer ({} when unknown)

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

  // Ask the server whether this account is on the allowlist (the allowed_emails table). This is
  // a UX gate only — the data layer (RLS) and the API enforce access regardless —
  // so on any error (offline, local dev without functions) we fail open and let
  // the app render; non-allowlisted users simply see empty data + 403 on sync.
  //
  // Keyed on the user id (not the whole session) so routine token refreshes —
  // which fire on every mobile app-switch/focus — don't re-run this and unmount
  // the app. We only blank to "Checking access…" on the FIRST check; later
  // identity changes re-verify in the background without tearing down the app.
  const userId = session && session.user ? session.user.id : null;

  // Two-factor step-up. After any email sign-in (tapped or pasted link) the
  // session is aal1; an account with an authenticator app
  // needs aal2 before the app loads. Read from the session itself (no network).
  // `mfaForced` covers a session whose user record predates an enrollment made
  // on another device: the server answers /api/me with mfa_required.
  const [mfaForced, setMfaForced] = useState(false);
  const aal2 = isAal2(session);
  useEffect(() => { if (aal2 || !userId) setMfaForced(false); }, [aal2, userId]);
  const needMfa = !!session && (needsStepUp(session) || (mfaForced && !aal2));

  useEffect(() => {
    if (!userId) { setAuthorized(null); return; }
    if (needMfa) return; // ask for the code first; re-checked once it's in
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
        if (res.status === 403) { setMe({}); setAuthorized(false); return; }
        if (res.status === 401) {
          const j = await res.json().catch(() => null);
          if (cancelled) return;
          if (j && j.code === MFA_REQUIRED) { setMfaForced(true); return; }
        }
        if (res.ok) {
          const j = await res.json().catch(() => null);
          if (cancelled) return;
          setMe(j || {});
          setAuthorized(!(j && j.authorized === false));
          return;
        }
        setMe({});
        setAuthorized(true); // 401/other -> fail open
      } catch (e) {
        if (!cancelled) { setMe({}); setAuthorized(true); } // network / timeout / local dev -> fail open
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); ac.abort(); };
  }, [userId, needMfa]);

  if (loading) return <div style={S.center}>Loading…</div>;
  if (!session) return <SignIn />;
  if (needMfa) return <StepUp email={session.user && session.user.email} />;
  if (authorized === null) return <div style={S.center}>Checking access…</div>;
  if (authorized === false) return <NotAuthorized email={session.user && session.user.email} />;
  return typeof children === "function" ? children(me || {}) : children;
}

// The two-factor code prompt (signed in by email, account has an authenticator
// app). On success supabase-js swaps in the aal2 session (MFA_CHALLENGE_VERIFIED
// → onAuthStateChange) and AuthGate lets the app load. A full 6-digit code
// submits itself (iOS fills it from "one-time-code" suggestions).
export function StepUp({ email }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(value) {
    const c = String(value == null ? code : value).replace(/[^0-9]/g, "");
    if (c.length !== 6 || busy) return;
    setBusy(true);
    setError("");
    try { await verifyStepUp(c); }
    catch (e) { setError(friendlyMfaError(e)); setCode(""); }
    setBusy(false);
  }

  return (
    <div style={S.center}>
      <div style={S.card}>
        <h1 style={S.title}>Two-factor code</h1>
        <p style={S.sub}>
          {email ? <span>Signed in as <strong>{email}</strong>. </span> : null}
          Enter the 6-digit code from your authenticator app to finish signing in.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            style={Object.assign({}, S.input, S.code)}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            autoFocus
            placeholder="123456"
            value={code}
            onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 6); setCode(v); if (v.length === 6) submit(v); }}
            aria-label="Two-factor code"
          />
          <button style={S.button} type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Verify"}
          </button>
        </form>
        {error && <p style={S.error}>{error}</p>}
        <p style={Object.assign({}, S.sub, { marginTop: 14, marginBottom: 0 })}>
          Lost your phone? Use a backup authenticator app if you set one up, or ask an admin to reset two-factor for your account.
        </p>
        <button type="button" style={S.link} onClick={() => signOut()}>Sign out</button>
      </div>
    </div>
  );
}

function NotAuthorized({ email }) {
  return (
    <div style={S.center}>
      <div style={S.card}>
        <h1 style={S.title}>Access not enabled</h1>
        <p style={S.sub}>
          {email ? "The account " : "This account "}
          {email && <strong>{email}</strong>}
          {" doesn't have access to this app any more."}
        </p>
        <p style={{ ...S.sub, marginTop: 0 }}>
          The app is invite-only. If you think this is a mistake, ask the owner.
        </p>
        <button style={S.button} onClick={() => signOut()}>Sign out</button>
      </div>
    </div>
  );
}

// Ways in from one sign-in email:
//  - tap the link (signs in the browser it opens in), or
//  - paste the link here (long-press → Copy Link in Mail).
// Pasting matters on an iPhone Home Screen web app: it has its own storage,
// separate from Safari, and email links always open in Safari, so tapping
// would sign Safari in and leave the Home Screen app signed out.
function SignIn() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [sent, setSent] = useState(false); // email sent (or already in hand) -> show the paste step
  const [status, setStatus] = useState("idle"); // idle | sending | verifying | error
  const [error, setError] = useState("");
  const standalone = isStandalone();

  async function send(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setError("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin, shouldCreateUser: false },
    });
    if (error) {
      setError(isNoAccount(error) ? INVITE_ONLY : error.message);
      setStatus("error");
    } else {
      setSent(true);
      setStatus("idle");
    }
  }

  function fail(err, what) {
    setError(/expired|invalid|not found/i.test(String(err && err.message)) ? "That " + what + " didn't work — it may have expired or been used already (opening the link uses it up). Send a new email and try again." : String((err && err.message) || err));
    setStatus("error");
  }

  // On success onAuthStateChange swaps this screen for the app.
  async function signInWithLink(text) {
    const parsed = parseSignInLink(text);
    if (!parsed) { setError("That doesn't look like the sign-in link from the email. Copy the link itself (on a phone, press and hold it, then Copy Link; on a computer, right-click it, then Copy Link)."); setStatus("error"); return; }
    if (parsed.error) { setError("This sign-in link can only be used in the browser that requested it. Send a new email from here."); setStatus("error"); return; }
    setStatus("verifying");
    setError("");
    const r = parsed.accessToken
      ? await supabase.auth.setSession({ access_token: parsed.accessToken, refresh_token: parsed.refreshToken })
      : await supabase.auth.verifyOtp({ token_hash: parsed.tokenHash, type: parsed.type });
    if (r.error) fail(r.error, "link");
  }
  async function pasteLink() {
    try {
      const t = await navigator.clipboard.readText();
      setLink(t);
      if (t) signInWithLink(t);
    } catch (e) {
      setError("Couldn't read the clipboard — paste the link into the box instead.");
      setStatus("error");
    }
  }
  const canReadClipboard = typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function";

  return (
    <div style={S.center}>
      <div style={S.card}>
        <h1 style={S.title}>Tirekicker</h1>
        <p style={S.sub}>Sign in to load your synced data.</p>
        {sent ? (
          <div>
            <p style={S.sent}>
              {email ? <span>We emailed <strong>{email}</strong> a sign-in link. </span> : null}
              {standalone
                ? (email ? "Don't open it — it would sign in your browser, not this installed app. " : "") + "Copy the sign-in link from the email (press and hold it, then Copy Link) and paste it here:"
                : (email ? "Open it to sign in, or copy the link and paste it here:" : "Copy the link from your sign-in email and paste it here:")}
            </p>
            <form onSubmit={(e) => { e.preventDefault(); signInWithLink(link); }}>
              <input
                style={S.input}
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="Paste the sign-in link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                aria-label="Sign-in link"
              />
              <div style={{ display: "flex", gap: 8 }}>
                {canReadClipboard && (
                  <button type="button" style={Object.assign({}, S.button, S.secondary)} disabled={status === "verifying"} onClick={pasteLink}>Paste link</button>
                )}
                <button style={S.button} type="submit" disabled={status === "verifying" || !link.trim()}>
                  {status === "verifying" ? "Signing in…" : "Sign in with link"}
                </button>
              </div>
            </form>
            <button type="button" style={S.link} onClick={() => { setSent(false); setStatus("idle"); setLink(""); setError(""); }}>
              Use a different email or send a new one
            </button>
          </div>
        ) : (
          <div>
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
                {status === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
            </form>
            <button type="button" style={S.link} onClick={() => { setSent(true); setStatus("idle"); setError(""); }}>
              Already have a sign-in email? Paste its link
            </button>
          </div>
        )}
        {status === "error" && <p style={S.error}>{error}</p>}
        <div style={{ borderTop: "1px solid #1e2028", marginTop: 18, paddingTop: 14 }}>
          <p style={Object.assign({}, S.sub, { margin: "0 0 8px" })}>Just looking? Try it on an anonymized sample of a real search — no account needed.</p>
          <a href="/?demo" style={Object.assign({}, S.button, S.secondary, { display: "block", width: "100%", boxSizing: "border-box", textAlign: "center", textDecoration: "none" })}>Try the demo</a>
        </div>
      </div>
    </div>
  );
}

var INVITE_ONLY = "This app is invite-only, and there's no account for that email. Ask the owner for an invite, then use the email address it was sent to.";

// Supabase's answer when the email has no account and none may be created
// (shouldCreateUser: false, or sign-ups turned off for the project).
export function isNoAccount(err) {
  var code = String((err && (err.code || err.error_code)) || "");
  var msg = String((err && err.message) || "");
  return code === "otp_disabled" || code === "signup_disabled" || code === "user_not_found" || /signups? not allowed|user not found/i.test(msg);
}

// Running as an installed web app (not a browser tab)?
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
  link: { background: "none", border: "none", color: "#6b9bf2", fontSize: 12, marginTop: 12, padding: 0, cursor: "pointer", fontFamily: "inherit", display: "block" },
  secondary: { background: "#1f2a44", width: "auto", flex: "0 0 auto" },
  error: { fontSize: 13, color: "#c44", marginTop: 10 },
};
