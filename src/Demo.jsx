import { useState, useEffect, useCallback } from "react";
import { loadDemo, DEMO_EVENT } from "./demoRuntime";
import { buildDemoSnapshot, reviewableNotes } from "./demo.js";
import { supabase } from "./supabaseClient";
import { startTutorial } from "./tutorial.js";

// Demo mode chrome (/?demo): waits for the published snapshot, then shows the
// app under a slim banner, with a welcome on the first visit and toasts for
// anything the demo can't do. See src/demoRuntime.js.

var WELCOME_KEY = "cs-demo-welcomed";
var REPO = "https://github.com/zalimeni/car-shopper";

export function DemoShell({ children }) {
  var [state, setState] = useState("loading"); // loading | ready | missing
  var [about, setAbout] = useState(false);
  var [first, setFirst] = useState(false); // first visit: closing the welcome starts the tutorial
  var [toasts, setToasts] = useState([]);

  useEffect(function () {
    loadDemo().then(function (d) {
      setState(d ? "ready" : "missing");
      if (d) {
        var seen = false;
        try { seen = !!localStorage.getItem(WELCOME_KEY); } catch (e) { /* private mode */ }
        if (!seen) { setFirst(true); setAbout(true); }
      }
    });
  }, []);

  useEffect(function () {
    var n = 0;
    function onToast(e) {
      var id = ++n + ":" + Date.now();
      var msg = String(e.detail || "");
      setToasts(function (t) { return t.filter(function (x) { return x.msg !== msg; }).concat([{ id: id, msg: msg }]).slice(-3); });
      setTimeout(function () { setToasts(function (t) { return t.filter(function (x) { return x.id !== id; }); }); }, 4500);
    }
    window.addEventListener(DEMO_EVENT, onToast);
    return function () { window.removeEventListener(DEMO_EVENT, onToast); };
  }, []);

  function closeAbout(tutorial) {
    setAbout(false);
    setFirst(false);
    try { localStorage.setItem(WELCOME_KEY, "1"); } catch (e) { /* private mode */ }
    if (tutorial) setTimeout(startTutorial, 150);
  }

  if (state === "loading") return <div style={D.center}>Loading the demo…</div>;
  if (state === "missing") return (
    <div style={D.center}>
      <div style={D.card}>
        <h1 style={D.h1}>The demo isn't available</h1>
        <p style={D.p}>There's no published demo right now — try again later.</p>
        <a href="/" style={D.btn}>Go to sign in</a>
      </div>
    </div>
  );
  return (
    <>
      <div style={D.banner} role="note" data-tour="banner">
        <span style={{ flex: 1, minWidth: 0 }}><b style={{ color: "#f0d78a" }}>Demo</b><span className="cs-demo-more"> · nothing is saved</span></span>
        <button style={D.bannerBtn} onClick={startTutorial}>Tutorial</button>
        <button style={D.bannerBtn} onClick={function () { setAbout(true); }}>About</button>
        <button style={D.bannerBtn} title="Start the demo over (edits are kept only in this tab)" onClick={function () { window.location.reload(); }}>Reset</button>
        <a style={D.bannerBtn} href="/">Sign in</a>
      </div>
      {children}
      {about && <WelcomeModal first={first} onClose={closeAbout} />}
      <div style={D.toasts} aria-live="polite">
        {toasts.map(function (t) { return <div key={t.id} style={D.toast} role="status">{t.msg}</div>; })}
      </div>
    </>
  );
}

function useEscape(onClose) {
  useEffect(function () {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return function () { window.removeEventListener("keydown", onKey); };
  }, [onClose]);
}

// first: the first visit — dismissing it any way but "Explore on my own" starts the tutorial.
export function WelcomeModal({ onClose, first }) {
  var dismiss = useCallback(function () { onClose(!!first); }, [onClose, first]);
  useEscape(dismiss);
  var li = { margin: "0 0 6px", lineHeight: 1.55 };
  return (
    <div onMouseDown={dismiss} style={D.backdrop}>
      <div role="dialog" aria-modal="true" aria-label="Welcome" onMouseDown={function (e) { e.stopPropagation(); }} style={D.dialog}>
        <h2 style={D.h1}>👋 Welcome</h2>
        <p style={D.p}>Thanks for checking out my project! This is the tracker I built for my own used-car search: profiles for the cars I'm shopping, dealer inventory pulled from MarketCheck nationwide, AI scores against my own criteria, and a watchlist that follows prices until a car sells. I made an actual SUV purchase using this app in October 2026!</p>
        <p style={D.p}>What you're seeing is a curated slice of my real search: real cars, prices and AI scores, with dealers and VINs swapped for made-up ones and the photos redrawn. Poke at anything — edits work, but they live only in this tab. <b>↻ Sync</b> on Results is simulated: it "finds" a few held-back listings, drops a couple of prices, and marks a car sold, counting against a pretend MarketCheck quota. <b>✨ Score</b> works too, but the scores are modeled on similar cars I already scored rather than asked of Claude. The Price tab, the new-profile wizard (+ Add on Profiles) and the AI price baseline are simulated the same way. No live MarketCheck or AI calls are made. (If you're interested in access and know me at work or personally, let me know and I can invite you to sign up, or you can self-host with your own accounts!)</p>

        <h3 style={D.h3}>How this app uses Supabase</h3>
        <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 13, color: "#c8c8d0" }}>
          <li style={li}><b>Sign-in:</b> email magic links or one-time codes (Supabase Auth), plus an allowlist — anyone can request a link, only approved emails get in.</li>
          <li style={li}><b>User data:</b> one JSON document per user in a Postgres table, guarded by row-level security, so a user can only ever read or write their own row. A simple revision counter stops two devices from overwriting each other.</li>
          <li style={li}><b>Backups:</b> a database trigger keeps rolling snapshots of that document, restorable from the app.</li>
          <li style={li}><b>AI key vault:</b> each user's Anthropic key is encrypted (AES-256-GCM) and only the server functions can read it.</li>
          <li style={li}><b>Schema changes:</b> SQL migrations, applied by GitHub Actions on merge.</li>
          <li style={li}><b>This demo:</b> none of it. The data is a static file that ships with the app, and nothing you do here is sent anywhere.</li>
        </ul>
        <p style={D.p}>A two-minute tutorial walks you through it next; Tutorial in the banner replays it any time.</p>
        <p style={Object.assign({}, D.p, { marginBottom: 4 })}>Enjoy, and thanks again for stopping by!</p>
        <p style={Object.assign({}, D.p, { color: "#e4e4e7" })}>— Michael</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={D.btn} onClick={function () { onClose(true); }}>Start the tutorial</button>
          <button style={D.small} onClick={function () { onClose(false); }}>{first ? "Explore on my own" : "Close"}</button>
          <a href={REPO} target="_blank" rel="noopener noreferrer" style={D.link}>Source on GitHub ↗</a>
        </div>
      </div>
    </div>
  );
}

// Owner side: review the notes, then publish the scrubbed snapshot
// (POST /api/snapshots { demo } — admins only, written with the service role).
export function DemoPublishModal({ data, candidates, onClose }) {
  useEscape(onClose);
  var full = Object.assign({}, data, { candidates: candidates });
  var items = reviewableNotes(full);
  var [keep, setKeep] = useState({});
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState("");
  var snap = buildDemoSnapshot(full, { keep: keep });
  var counts = (snap.data.listings || []).length + " listings, " + (snap.data.candidates || []).length + " queued, " + snap.pool.length + " held back for demo syncs";

  async function publish() {
    setBusy(true); setMsg("");
    try {
      var s = await supabase.auth.getSession();
      var token = s.data && s.data.session ? s.data.session.access_token : "";
      var res = await fetch("/api/snapshots", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ demo: buildDemoSnapshot(full, { keep: keep }) }) });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
      setMsg("Published — open " + window.location.origin + "/?demo=live to see it.");
    } catch (e) { setMsg("Publish failed: " + (e.message || e)); }
    setBusy(false);
  }

  return (
    <div onMouseDown={onClose} style={D.backdrop}>
      <div role="dialog" aria-modal="true" aria-label="Publish demo" onMouseDown={function (e) { e.stopPropagation(); }} style={D.dialog}>
        <h2 style={D.h1}>Publish demo</h2>
        <p style={D.p}>Publishes a copy of your data as it is now to <code>/?demo=live</code> (the public <code>/?demo</code> uses the curated fixture in the repo): {counts}. Removed always: MarketCheck keys, quota records, API-version info. Kept: profiles, criteria, listings, prices, tags, AI scores, home base.</p>
        <h3 style={D.h3}>Your notes ({items.length})</h3>
        <p style={Object.assign({}, D.p, { fontSize: 12 })}>Unchecked notes are cleared (price-change notes sync wrote are always kept).</p>
        {items.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button style={D.small} onClick={function () { var k = {}; items.forEach(function (i) { k[i.key] = true; }); setKeep(k); }}>Keep all</button>
            <button style={D.small} onClick={function () { setKeep({}); }}>Drop all</button>
          </div>
        )}
        <div style={{ maxHeight: "40vh", overflowY: "auto", marginBottom: 12 }}>
          {items.map(function (i) {
            return (
              <label key={i.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid #1e2028", fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={!!keep[i.key]} onChange={function (e) { var on = e.target.checked; setKeep(function (k) { var n = Object.assign({}, k); if (on) n[i.key] = true; else delete n[i.key]; return n; }); }} style={{ marginTop: 3 }} />
                <span style={{ minWidth: 0 }}>
                  <b style={{ color: "#e4e4e7" }}>{i.name}</b>
                  {i.memo && <span style={{ display: "block", color: "#a8a8b3", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{i.memo}</span>}
                  {i.notes && <span style={{ display: "block", color: "#8a8a96", overflowWrap: "anywhere" }}>{i.notes}</span>}
                </span>
              </label>
            );
          })}
        </div>
        {msg && <p style={Object.assign({}, D.p, { color: /failed/.test(msg) ? "#e07a7a" : "#3fae74" })}>{msg}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button style={Object.assign({}, D.btn, busy ? { opacity: 0.6 } : {})} disabled={busy} onClick={publish}>{busy ? "Publishing…" : "Publish"}</button>
          <button style={D.small} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

var font = "'IBM Plex Sans','SF Pro Text',-apple-system,sans-serif";
var D = {
  center: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f1114", color: "#e4e4e7", fontFamily: font, padding: 16 },
  card: { background: "#161820", border: "1px solid #1e2028", borderRadius: 12, padding: 24, width: "100%", maxWidth: 360 },
  banner: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#c8c8d0", background: "#221d0e", borderBottom: "1px solid #3d3218", padding: "6px 12px", fontFamily: font, lineHeight: 1.4 },
  bannerBtn: { background: "none", border: "1px solid #3d3218", borderRadius: 6, color: "#f0d78a", fontSize: 12, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit", textDecoration: "none", whiteSpace: "nowrap" },
  backdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.62)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 12px 12px", overflowY: "auto", fontFamily: font },
  dialog: { width: "100%", maxWidth: 560, background: "#161820", border: "1px solid #1e2028", borderRadius: 10, padding: 18, boxShadow: "0 16px 48px rgba(0,0,0,0.6)", color: "#e4e4e7", boxSizing: "border-box" },
  h1: { fontSize: 19, fontWeight: 600, margin: "0 0 8px", color: "#f0f0f3" },
  h3: { fontSize: 14, fontWeight: 600, margin: "14px 0 6px", color: "#f0f0f3" },
  p: { fontSize: 13, color: "#a8a8b3", margin: "0 0 10px", lineHeight: 1.55 },
  btn: { display: "inline-block", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "9px 16px", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", textDecoration: "none" },
  small: { background: "none", border: "1px solid #2a2d38", borderRadius: 6, color: "#c8c8d0", fontSize: 12, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit" },
  link: { color: "#6b9bf2", fontSize: 13 },
  toasts: { position: "fixed", left: 12, right: 12, bottom: 16, zIndex: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, pointerEvents: "none" },
  toast: { maxWidth: 440, background: "#1f2433", border: "1px solid #34405e", color: "#e4e4e7", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontFamily: font, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", lineHeight: 1.45 },
};
