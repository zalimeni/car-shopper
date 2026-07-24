// Lightweight load-stage instrumentation. The app has been hanging on a loading
// screen with no way to see where; this records each milestone (console + a
// window global) and renders the current stage + a live timer on the loading
// screens, so a stuck screen tells us exactly where it's wedged.
import { useState, useEffect } from "react";

var t0 = Date.now();

export function diag(stage) {
  var s = (Date.now() - t0) / 1000;
  try {
    if (typeof window !== "undefined") {
      window.__csLoad = stage;
      (window.__csStages = window.__csStages || []).push(s.toFixed(2) + "s " + stage);
    }
  } catch (e) { /* ignore */ }
  try { console.log("[cs-load " + s.toFixed(2) + "s] " + stage); } catch (e) { /* ignore */ }
}

// Current stage + seconds-since-load, ticking every second. Drop this into any
// loading screen so a hang is self-describing (e.g. "stage: auth:getSession · 22s").
export function LoadStamp() {
  var [, tick] = useState(0);
  useEffect(function () {
    var id = setInterval(function () { tick(function (x) { return x + 1; }); }, 1000);
    return function () { clearInterval(id); };
  }, []);
  var el = Math.floor((Date.now() - t0) / 1000);
  var stage = (typeof window !== "undefined" && window.__csLoad) || "start";
  return (
    <div style={{ fontSize: 11, color: "#6b6b76", marginTop: 10, fontFamily: "monospace" }}>
      stage: {stage} · {el}s
    </div>
  );
}
