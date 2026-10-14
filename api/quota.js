// MarketCheck quota probe: one tiny search per key, reading the monthly quota
// off the response headers. This is the only way to read a key's remaining calls
// without running a sync — and it is NOT free (each probe is one API call), so
// the UI only fires it when the user asks.
//
// POST { marketcheckKeys?: [...] }
//   -> { keys: [{ id, remaining, limit, reset, exhausted, status, error? }], calls }
// Keys are the caller's own (in order) then the shared server key, mirroring
// /api/marketcheck. Keys are never echoed back — only their short id.

import { authorize } from "./_auth.js";
import { buildProbeUrl, keyId, readQuota } from "./marketcheck.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const envKey = process.env.MARKETCHECK_API_KEY;
  const keys = (Array.isArray(body.marketcheckKeys) ? body.marketcheckKeys : []).map(function (k) { return String(k || "").trim(); }).filter(Boolean);
  if (envKey && keys.indexOf(envKey) === -1) keys.push(envKey);
  if (!keys.length) { res.status(400).json({ error: "No MarketCheck API key — add one in Settings, or set MARKETCHECK_API_KEY on the server" }); return; }

  const out = [];
  for (const k of keys) {
    const id = keyId(k, envKey);
    try {
      const r = await fetch(buildProbeUrl(k), { headers: { Accept: "application/json" } });
      let text = "";
      try { text = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
      const q = readQuota(r, text);
      out.push(Object.assign({ id: id, status: r.status }, q || { remaining: null, limit: null, reset: null, exhausted: false },
        r.ok || q ? {} : { error: r.status === 401 || r.status === 403 ? "Key rejected (HTTP " + r.status + ")" : "HTTP " + r.status }));
    } catch (e) {
      out.push({ id: id, status: 0, remaining: null, limit: null, reset: null, exhausted: false, error: (e && e.message) || "request failed" });
    }
  }
  res.status(200).json({ keys: out, calls: out.length });
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
