import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

// Gates the app behind Supabase email magic-link auth. Renders a sign-in
// screen until there's a session, then renders children. Signing in with the
// same email on any device gives you the same synced data.
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) return <div style={S.center}>Loading…</div>;
  if (!session) return <SignIn />;
  return children;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
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
      setStatus("sent");
    }
  }

  return (
    <div style={S.center}>
      <div style={S.card}>
        <h1 style={S.title}>Car Search Tracker</h1>
        <p style={S.sub}>Sign in to load your synced data.</p>
        {status === "sent" ? (
          <p style={S.sent}>
            Check <strong>{email}</strong> for a sign-in link, then return here.
          </p>
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
              {status === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        {status === "error" && <p style={S.error}>{error}</p>}
      </div>
    </div>
  );
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
  sent: { fontSize: 14, color: "#2d8659", lineHeight: 1.6 },
  error: { fontSize: 13, color: "#c44", marginTop: 10 },
};
