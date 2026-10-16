// Live-market comp broadening for the Price Check tool.
//
// POST { query:{year,make,model,trim,mileage}, hubs:[{n,z,lat,lon,r}], marketcheckKeys?:[...] }
//   -> { listings:[<normalized>], errors, rateLimited, rateLimitInfo, quota, keysUsed }
//
// Fires a one-off MarketCheck active search for the specific vehicle so the
// Price Check tool can widen a thin local comp pool with real current-market
// asking prices. Reuses the inventory sync's search engine (a "local" step:
// a radius search around one location), with a synthetic single-vehicle profile. Counts
// against the caller's MarketCheck quota (their own keys first, then the shared
// server key) — user-initiated, so quota burn stays in their control.

import { authorize } from "./_auth.js";
import { createSession, runStep, keyId, resolveKeys } from "./marketcheck.js";

// How far above the subject's mileage to fetch (client bands around it after).
const MILES_HEADROOM = 30000;

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const auth = await authorize(req);
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const q = body.query || {};
  const make = String(q.make || "").trim();
  const model = String(q.model || "").trim();
  if (!make && !model) { res.status(400).json({ error: "Need at least a make and model" }); return; }

  const hubs = Array.isArray(body.hubs) ? body.hubs : [];
  if (!hubs.length) { res.status(400).json({ error: "no_location", message: "Set a home base in Settings to check the live market" }); return; }

  // The caller's own keys (in order), or the shared server key only if they have none.
  const envKey = process.env.MARKETCHECK_API_KEY;
  const resolved = resolveKeys(body.marketcheckKeys, envKey);
  const keys = resolved.keys;
  if (!keys.length) { res.status(500).json({ error: "No MarketCheck API key — add one in Settings, or set MARKETCHECK_API_KEY on the server" }); return; }

  // Synthetic profile: same make/model, year widened ±1, mileage capped a bit
  // above the subject (no price cap — we want the whole comp distribution).
  const year = parseInt(q.year, 10) || 0;
  const mileage = parseInt(q.mileage, 10) || 0;
  const params = { make: make, model: model };
  if (year) params.years = (year - 1) + "-" + (year + 1);
  if (mileage) params.maxMiles = mileage + MILES_HEADROOM;
  const profile = { id: "pricecheck", name: "price check", params: params };

  try {
    const session = createSession(keys, { budgetMs: 45000, spentKeys: body.spentKeys, keyIds: keys.map(function (k) { return keyId(k, resolved.shared ? envKey : null); }) });
    const r = await runStep(session, { kind: "local", profile: profile, hub: hubs[0] });
    res.status(200).json({
      listings: r.listings,
      errors: r.errors,
      notices: r.notices,
      rateLimited: !!r.rateLimited,
      rateLimitInfo: r.rateLimitInfo || null,
      quota: r.quota || null,
      keysUsed: r.keysUsed,
      keyQuotas: r.keyQuotas || [],
      apiInfo: r.apiInfo,
      formatSuspect: !!r.formatSuspect,
      calls: r.calls || 0,
    });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : "Live market check failed" });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
