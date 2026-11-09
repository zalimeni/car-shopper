import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { TUTORIAL_EVENT, stepsFor, stepText, runsAction, placeCard, looksDone } from "./tutorial.js";

// The guided tutorial overlay (steps: src/tutorial.js). Mounted once in App;
// startTutorial() opens it. The screen dims except a spotlight on the step's
// [data-tour] element; a card beside it explains, with Back / Next / Skip.
// Taps outside the card are swallowed (one stray tap shouldn't end it), except
// on an action step's control, which the visitor may tap themselves.

var PAD = 6;           // spotlight padding around the target
var FIND_MS = 2500;    // how long to wait for a step's target to render
var DONE_MAX_MS = 25000;

function sel(id) { return '[data-tour="' + id + '"]'; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function sameRect(a, b) { return a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height; }

export function Tutorial({ demo }) {
  var steps = stepsFor(demo);
  var [on, setOn] = useState(false);
  var [i, setI] = useState(0);
  var [dir, setDir] = useState(1);
  var [el, setEl] = useState(null);
  var [ready, setReady] = useState(false);
  var [rect, setRect] = useState(null);
  var [busy, setBusy] = useState(false);
  var [vp, setVp] = useState({ w: typeof window !== "undefined" ? window.innerWidth : 390, h: typeof window !== "undefined" ? window.innerHeight : 800 });
  var [card, setCard] = useState({ w: 320, h: 180 });
  var cardRef = useRef(null);
  var stepRef = useRef(0); // guards async work against a step that's since moved on
  var step = on ? steps[i] : null;

  var close = useCallback(function () { setOn(false); setBusy(false); setEl(null); setRect(null); }, []);
  var go = useCallback(function (d) {
    setDir(d);
    setI(function (n) {
      var next = n + d;
      if (next >= steps.length) { setOn(false); return n; }
      return Math.max(0, next);
    });
  }, [steps.length]);

  useEffect(function () {
    function start() { setI(0); setDir(1); setBusy(false); setOn(true); }
    window.addEventListener(TUTORIAL_EVENT, start);
    return function () { window.removeEventListener(TUTORIAL_EVENT, start); };
  }, []);

  // Enter a step: switch tab, find the target, bring it into view.
  useEffect(function () {
    if (!on) return;
    var s = steps[i];
    if (!s) { close(); return; }
    var token = ++stepRef.current;
    setReady(false); setEl(null); setRect(null); setBusy(false);
    if (s.tab) { var h = "#" + s.tab.toLowerCase(); if (window.location.hash.split("/")[0] !== h) window.location.hash = h; }
    if (!s.target) { setReady(true); return; }
    (async function () {
      var t0 = Date.now(), found = null;
      while (!found && Date.now() - t0 < FIND_MS) {
        found = document.querySelector(sel(s.target));
        if (!found) await sleep(100);
        if (token !== stepRef.current) return;
      }
      if (!found) { // nothing to show here (e.g. no candidates in the queue): skip it
        if (i + dir < 0) go(1); else go(dir);
        return;
      }
      var tall = found.getBoundingClientRect().height > window.innerHeight * 0.5;
      if (found.scrollIntoView) {
        try { found.scrollIntoView({ block: tall ? "start" : "center", behavior: "smooth" }); } catch (e) { found.scrollIntoView(); }
      }
      setEl(found);
      // Show the card once the scroll has settled (same spot for ~150 ms).
      var last = null, still = 0, t1 = Date.now();
      while (Date.now() - t1 < 1500) {
        await sleep(50);
        if (token !== stepRef.current) return;
        var y = Math.round(found.getBoundingClientRect().top);
        still = y === last ? still + 1 : 0;
        last = y;
        if (still >= 3) break;
      }
      setReady(true);
    })();
  }, [on, i]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the target (scrolling, layout changes, a sync filling the page).
  useEffect(function () {
    if (!on || !step || !step.target) return;
    var raf, cur = el;
    function tick() {
      if (cur && !cur.isConnected) cur = document.querySelector(sel(step.target));
      if (cur) {
        var r = cur.getBoundingClientRect();
        var nr = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
        setRect(function (prev) { return sameRect(prev, nr) ? prev : nr; });
      }
      setVp(function (prev) { return prev.w === window.innerWidth && prev.h === window.innerHeight ? prev : { w: window.innerWidth, h: window.innerHeight }; });
      raf = requestAnimationFrame(tick);
    }
    if (el) tick();
    return function () { cancelAnimationFrame(raf); };
  }, [on, el, step]);

  useLayoutEffect(function () {
    if (!cardRef.current) return;
    var w = cardRef.current.offsetWidth, h = cardRef.current.offsetHeight;
    if (w !== card.w || h !== card.h) setCard({ w: w, h: h });
  });

  useEffect(function () {
    if (!on) return;
    function onKey(e) { if (e.key === "Escape") close(); else if (e.key === "ArrowRight" && !busy) next(); else if (e.key === "ArrowLeft" && !busy) go(-1); }
    window.addEventListener("keydown", onKey);
    return function () { window.removeEventListener("keydown", onKey); };
  });

  // An action step: wait for the tapped control to finish, then move on.
  var waitThenNext = useCallback(async function (target) {
    var token = stepRef.current;
    setBusy(true);
    await sleep(350); // let it flip to its busy state
    var t0 = Date.now();
    while (Date.now() - t0 < DONE_MAX_MS) {
      if (token !== stepRef.current) return;
      var cur = target && target.isConnected ? target : document.querySelector(sel(steps[i].target));
      if (looksDone(cur)) break;
      await sleep(200);
    }
    if (token !== stepRef.current) return;
    await sleep(400); // a beat to see the result
    if (token === stepRef.current) go(1);
  }, [i, go, steps]);

  // The visitor taps the highlighted control themselves.
  useEffect(function () {
    if (!on || !el || !runsAction(step, demo)) return;
    function onTap() { if (!busy) waitThenNext(el); }
    el.addEventListener("click", onTap);
    return function () { el.removeEventListener("click", onTap); };
  }, [on, el, step, demo, busy, waitThenNext]);

  function next() {
    if (busy) return;
    if (runsAction(step, demo) && el) { el.click(); return; } // the listener above takes it from here
    go(1);
  }

  if (!on || !step) return null;

  var hole = rect && ready ? {
    top: Math.max(0, rect.top - PAD), left: Math.max(0, rect.left - PAD),
    width: rect.width + PAD * 2, height: rect.height + PAD * 2,
  } : null;
  // A tall target is clipped to the screen so the card can still sit beside it.
  if (hole) {
    var bottom = Math.min(vp.h - 4, hole.top + hole.height);
    hole.top = Math.max(4, hole.top);
    hole.height = Math.max(0, bottom - hole.top);
  }
  var cw = Math.min(340, vp.w - 20);
  var pos = placeCard(hole, { w: cw, h: card.h }, vp);
  var tappable = runsAction(step, demo) && !busy;
  var block = { position: "fixed", pointerEvents: "auto", background: "transparent" };
  var n = steps.length;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 250, pointerEvents: "none" }} aria-live="polite">
      {hole ? (
        <>
          <div style={{ position: "fixed", top: hole.top, left: hole.left, width: hole.width, height: hole.height, borderRadius: 10,
            boxShadow: "0 0 0 9999px rgba(4,6,12,0.68)", border: "2px solid #6b9bf2", pointerEvents: "none",
            transition: "top 0.2s, left 0.2s, width 0.2s, height 0.2s" }} />
          <div style={Object.assign({}, block, { top: 0, left: 0, right: 0, height: hole.top })} />
          <div style={Object.assign({}, block, { top: hole.top + hole.height, left: 0, right: 0, bottom: 0 })} />
          <div style={Object.assign({}, block, { top: hole.top, left: 0, width: hole.left, height: hole.height })} />
          <div style={Object.assign({}, block, { top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height })} />
          {!tappable && <div style={Object.assign({}, block, { top: hole.top, left: hole.left, width: hole.width, height: hole.height })} />}
        </>
      ) : (
        <div style={Object.assign({}, block, { inset: 0, background: "rgba(4,6,12,0.68)" })} />
      )}
      {(ready || !step.target) && (
        <div ref={cardRef} role="dialog" aria-modal="true" aria-label={"Tutorial: " + step.title}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: cw, boxSizing: "border-box", pointerEvents: "auto",
            background: "#161a26", border: "1px solid #34405e", borderRadius: 12, padding: "14px 16px 12px", color: "#e4e4e7",
            boxShadow: "0 16px 48px rgba(0,0,0,0.6)", fontFamily: "'IBM Plex Sans','SF Pro Text',-apple-system,sans-serif" }}>
          {pos.arrow && (
            <span aria-hidden="true" style={{ position: "absolute", left: pos.arrowX - 7, width: 14, height: 14, background: "#161a26",
              transform: "rotate(45deg)", border: "1px solid #34405e",
              borderRight: pos.arrow === "up" ? "none" : undefined, borderBottom: pos.arrow === "up" ? "none" : undefined,
              borderLeft: pos.arrow === "down" ? "none" : undefined, borderTop: pos.arrow === "down" ? "none" : undefined,
              top: pos.arrow === "up" ? -8 : undefined, bottom: pos.arrow === "down" ? -8 : undefined }} />
          )}
          <div style={{ fontSize: 11, color: "#6b9bf2", fontWeight: 600, letterSpacing: "0.04em", marginBottom: 4 }}>TUTORIAL · {i + 1} / {n}</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: "#f0f0f3" }}>{step.title}</div>
          <div style={{ fontSize: 13.5, color: "#c8c8d0", lineHeight: 1.55 }}>{stepText(step, demo)}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <button onClick={close} style={T.link}>Skip</button>
            <span style={{ flex: 1 }} />
            {i > 0 && <button onClick={function () { if (!busy) go(-1); }} disabled={busy} style={T.back}>Back</button>}
            <button onClick={next} disabled={busy} style={Object.assign({}, T.next, busy ? { opacity: 0.7 } : {})}>
              {busy ? "Working…" : i === n - 1 ? "Done" : "Next"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

var T = {
  link: { background: "none", border: "none", color: "#8a8a96", fontSize: 13, padding: "6px 2px", cursor: "pointer", fontFamily: "inherit" },
  back: { background: "none", border: "1px solid #2a2d38", borderRadius: 6, color: "#c8c8d0", fontSize: 13, padding: "7px 12px", cursor: "pointer", fontFamily: "inherit" },
  next: { background: "#2563eb", border: "none", borderRadius: 6, color: "#fff", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", minWidth: 84 },
};
