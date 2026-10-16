// Serverless proxy for MarketCheck active-inventory search.
//
// Holds MARKETCHECK_API_KEY (server-side only) and translates the app's active
// vehicle profiles into MarketCheck queries, returning listings normalized to
// the app's shape. The browser never sees the key.
//
// Request:  POST one sync step (see src/syncPlan.js):
//           { kind: "full" | "new" | "count" | "vins", profile: { id, name, params },
//             since, vins, excludeSalt, franchiseOnly, marketcheckKeys, spentKeys }
// Response: { listings: [<normalized>], numFound, errors, notices, calls, keyQuotas, ... }
//
// Searches are nationwide, one profile at a time, with salt-belt states left out
// via `state=` (src/regions.js). Verified live (Oct 2026, free plan): no-location
// searches, `state=` and `vin=` lists, `sort_by=dos_active`, and rows=0 counts.
//
// Param/response field names follow the MarketCheck Cars API v2
// (GET /v2/search/car/active) and are isolated in buildUrl()/normalize() so any
// API drift is a one-file change. Pass ?mock=1 to get synthetic data for
// exercising the full sync → candidate → approve flow without calling
// MarketCheck (and before the live field mapping is confirmed). Pass ?raw=1 to
// run one real query and return the raw MarketCheck response + how normalize()
// maps it, for confirming live field names (API key redacted from the echo).

import { authorize } from "./_auth.js";
import { mapPowertrain, parseYears } from "../src/queryPlan.js";
import { searchStates } from "../src/regions.js";
import { isoMcTime } from "../src/quota.js";

export { mapPowertrain, parseYears };

const HOST = process.env.MARKETCHECK_HOST || "https://api.marketcheck.com";
const ENDPOINT = "/v2/search/car/active";
// Radius for the one location-based search left (Price Check's live comps around
// the home base). Free tier caps it at 100mi; override with MARKETCHECK_RADIUS.
const RADIUS_MI = Number(process.env.MARKETCHECK_RADIUS) || 100;
const ROWS = 50; // page size per request
// Rows Price Check's live comps search pages up to (override: MARKETCHECK_MAX_ROWS).
const MAX_ROWS = Number(process.env.MARKETCHECK_MAX_ROWS) || 200;
// Only car_type=used is queried: it already includes certified pre-owned. Verified
// against the live API (Oct 2026, 2021-22 RAV4 within 100 mi of Durham): used=167,
// used+exclude_certified=156, certified=11 — so a separate certified query just
// paid again for the same 11 cars. CPO is still detected per row (isCpo).
// The account's pagination ceiling (start + rows); beyond it MarketCheck answers
// 422 "Subscribed package pagination limit of 500 rows exceeded" — and still
// charges the call.
const PAGE_LIMIT = Number(process.env.MARKETCHECK_PAGE_LIMIT) || 500;
// Free tier rate-limits bursts; space sequential queries out and retry 429s.
const THROTTLE_MS = Number(process.env.MARKETCHECK_THROTTLE_MS) || 500;
const MAX_RETRIES = 3;
// No single MarketCheck call may hang the function: past this it's abandoned.
const CALL_TIMEOUT_MS = Number(process.env.MARKETCHECK_CALL_TIMEOUT_MS) || 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API version pinning ──
// Without an x-version header MarketCheck serves its current default, and moves
// unpinned clients to the next major version on its own schedule. Responses in
// Oct 2026 said the default (v4.8.0) was deprecated 2026-08-07, sunset 2027-02-28.
// Pinning keeps us on the version normalize()/buildUrl() were validated against
// until we choose to move. Set MARKETCHECK_API_VERSION to change it, or to an
// empty string to send no pin at all.
export const API_VERSION = process.env.MARKETCHECK_API_VERSION != null ? String(process.env.MARKETCHECK_API_VERSION).trim() : "v4.8.0";

function withVersion(opts, pin) {
  const headers = Object.assign({ Accept: "application/json" }, (opts && opts.headers) || {});
  if (pin && API_VERSION) headers["x-version"] = API_VERSION;
  return Object.assign({}, opts || {}, { headers: headers });
}

// Version + lifecycle headers on a response, or null when it carries none.
export function readApiInfo(r) {
  const h = function (k) { return r && r.headers && r.headers.get ? r.headers.get(k) : null; };
  const info = {
    served: h("served-by-version"), requested: h("requested-from-version"), autoUpgraded: h("auto-upgraded-version"),
    deprecation: h("deprecation"), sunset: h("sunset"),
  };
  return info.served || info.requested || info.deprecation || info.sunset ? info : null;
}

// Fetch that retries on HTTP 429 with backoff (honoring Retry-After), sending the
// pinned API version. If MarketCheck rejects the pin itself it retries once
// unpinned, so a bad pin can't take sync down — and says so via meter.pinRejected,
// which the UI surfaces. Verified live (Oct 2026): an unknown x-version answers
// HTTP 404 {"message":"release not found"} — so a 400 or 404 whose body names the
// release/version counts as a rejected pin.
async function fetchWithRetry(url, opts, maxRetries, meter) {
  const limit = maxRetries != null ? maxRetries : MAX_RETRIES;
  let attempt = 0;
  let pin = !!API_VERSION && !(meter && meter.pinRejected);
  while (true) {
    if (meter) meter.calls++; // every request actually sent, retries included
    let r;
    try {
      r = await fetch(url, withVersion(Object.assign({ signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }, opts || {}), pin));
    } catch (e) {
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error("MarketCheck didn't answer within " + Math.round(CALL_TIMEOUT_MS / 1000) + " s");
      throw e;
    }
    if (pin && (r.status === 400 || r.status === 404)) {
      let text = "";
      try { text = r.clone ? await r.clone().text() : ""; } catch (e) { /* ignore */ }
      if (/release|version/i.test(text)) { pin = false; if (meter) meter.pinRejected = true; continue; }
    }
    if (meter) { const a = readApiInfo(r); if (a) meter.api = a; }
    // A 429 that says the MONTH is spent won't clear by waiting — return at once.
    // One that's just the per-second throttle does, so back off and retry.
    if (r.status !== 429 || attempt >= limit || await isSpent(r)) return r;
    const ra = parseFloat(r.headers.get("retry-after") || "");
    const waitMs = ra > 0 ? Math.min(ra * 1000, 5000) : Math.min(500 * Math.pow(2, attempt), 4000);
    await sleep(waitMs);
    attempt++;
  }
}

// Short, non-secret handle for a key: the shared server key is "shared", any
// other is its last four characters (what the Settings list can also derive).
export function keyId(key, sharedKey) {
  return sharedKey && key === sharedKey ? "shared" : String(key || "").slice(-4);
}

// Monthly quota as reported on a response (headers are on every response). A 429
// is ambiguous — it's also the per-second throttle — so a key only counts as
// exhausted when the monthly counter says 0 or the body names the monthly quota.
export function readQuota(r, bodyText) {
  const num = function (v) { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const h = function (k) { return r.headers && r.headers.get ? r.headers.get(k) : null; };
  const remaining = num(h("quota-remaining"));
  const limit = num(h("quota-limit"));
  const reset = isoMcTime(h("quota-reset-time"));
  const quotaWords = /quota|monthly/i.test(String(bodyText || ""));
  // Retry-After of an hour or more can only mean "next month" — the per-second
  // throttle clears in seconds. 402 (payment required) is always a spent plan.
  const retryAfter = num(h("retry-after"));
  const longWait = retryAfter != null && retryAfter >= 3600;
  const spent = r.status === 402 || ((r.status === 429 || r.status === 503) && (remaining === 0 || longWait || (remaining == null && quotaWords)));
  if (remaining == null && limit == null && !reset && !spent) return null;
  return { remaining: spent ? 0 : remaining, limit: limit, reset: reset, exhausted: !!spent };
}

// Is this response a spent MONTHLY quota, as opposed to a momentary throttle?
// Looks at the headers and, when it can without consuming the body, the message.
async function isSpent(r) {
  if (r.status === 402) return true;
  if (r.status !== 429 && r.status !== 503) return false;
  let text = "";
  try { text = r.clone ? await r.clone().text() : ""; } catch (e) { /* headers alone then */ }
  const q = readQuota(r, text);
  return !!(q && q.exhausted);
}

// The keys a request may use, in order. The caller's own list is the whole story:
// when it has anything in it the shared server key (MARKETCHECK_API_KEY) is
// ignored entirely — not appended, not counted, not a fallback even once every
// configured key is spent. It is used only when the list is empty.
// -> { keys, shared } (shared = we're running on the server key)
// Duplicates are NOT handled here: Settings de-duplicates when keys are saved.
export function resolveKeys(rawKeys, envKey) {
  const list = (Array.isArray(rawKeys) ? rawKeys : []).map(function (k) { return String(k || "").trim(); }).filter(Boolean);
  if (list.length) return { keys: list, shared: false };
  return { keys: envKey ? [envKey] : [], shared: !!envKey };
}

// The ordered key list as a cursor, so a run that rolls over to key #2 keeps
// using it for its remaining calls instead of re-hitting the spent one.
function keyRing(keys) {
  return {
    i: 0,
    keys: keys,
    key: function () { return keys[this.i]; },
    next: function () { if (this.i + 1 < keys.length) { this.i++; return true; } return false; },
    used: function () { return { keyUsed: this.i + 1, keysAvailable: keys.length }; },
  };
}

// fetchWithRetry, but on a quota/rate-limit response move to the next key in the
// ring and repeat the same request — but only when the key's MONTHLY quota is
// spent. A momentary throttle is retried on the same key (fetchWithRetry), since
// the next key would just be spending someone else's quota to dodge a pause.
async function fetchAcrossKeys(ring, makeUrl, opts, meter) {
  while (true) {
    const url = makeUrl(ring.key());
    const r = await fetchWithRetry(url, opts, undefined, meter);
    if ((await isSpent(r)) && ring.next()) continue;
    return { r: r, url: url };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  // Server-side access control: authenticated AND allowlisted, or no inventory.
  const auth = await authorize(req);
  if (auth.error) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];
  const hubs = Array.isArray(body.hubs) ? body.hubs : [];
  // Optional dealer-type narrowing: franchiseOnly restricts the search to
  // franchise dealers (excludes independents).
  const dealerType = body.franchiseOnly ? "franchise" : null;
  const mock = req.query && (req.query.mock === "1" || req.query.mock === "true");
  const raw = req.query && (req.query.raw === "1" || req.query.raw === "true");

  if (mock) {
    res.status(200).json({ listings: body.kind === "vins" ? [] : mockListings(body.profile ? [body.profile] : profiles, hubs), errors: [], mock: true });
    return;
  }

  // The caller's own MarketCheck keys, in priority order — or, only if they have
  // none, the shared server key. Search moves to the next key only when one's
  // monthly quota is spent (resolveKeys / isSpent).
  const envKey = process.env.MARKETCHECK_API_KEY;
  const resolved = resolveKeys(body.marketcheckKeys, envKey);
  const keys = resolved.keys;
  if (!keys.length) {
    res.status(500).json({ error: "No MarketCheck API key — add one in Settings, or set MARKETCHECK_API_KEY on the server" });
    return;
  }
  const apiKey = keys[0];

  // Debug: run one real query (first profile × first hub) and return the raw
  // MarketCheck response alongside how normalize() maps it — for confirming the
  // live field names. Key redacted from the echoed URL.
  // VIN lookup (raw mode): fetch every active record MarketCheck has for one VIN
  // and lay out all its price-related fields — for answering "why does the app
  // show a different price than the dealer's site?" without guessing.
  if (raw && typeof body.vin === "string" && body.vin.trim()) {
    const vin = body.vin.trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) { res.status(400).json({ error: "That doesn't look like a 17-character VIN" }); return; }
    const ring = keyRing(keys);
    const out = { request: buildVinUrl("REDACTED", vin), vin: vin };
    try {
      const vm = { calls: 0 };
      const f = await fetchAcrossKeys(ring, function (k) { return buildVinUrl(k, vin); }, {}, vm);
      const r = f.r;
      out.apiVersion = Object.assign({ pinned: API_VERSION || null, pinRejected: !!vm.pinRejected }, vm.api || {});
      Object.assign(out, ring.used());
      out.status = r.status;
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
      const rows = json && Array.isArray(json.listings) ? json.listings : [];
      out.num_found = json && json.num_found != null ? json.num_found : rows.length;
      out.records = rows.map(function (row) { return Object.assign(priceFacts(row), { appWouldStore: normalize(row, "debug").price }); });
      out.rawRecords = rows.map(stripMedia);
      if (!r.ok || !rows.length) out.body = text.slice(0, 600);
    } catch (e) {
      out.error = e && e.message ? e.message : "fetch failed";
    }
    res.status(200).json(JSON.parse(JSON.stringify(out).replace(/api_key=[^"&\\\s]+/g, "api_key=REDACTED")));
    return;
  }

  if (raw) {
    const pr = profiles[0] || body.profile;
    const hub = hubs[0] || { national: true }; // nationwide unless a hub is given
    if (!pr) {
      res.status(400).json({ error: "raw mode needs a profile" });
      return;
    }
    const ring = keyRing(keys);
    const url = buildUrl("REDACTED", pr, hub);
    const debug = { request: url, profile: pr.id, hub: hub };
    try {
      const dm = { calls: 0 };
      const f = await fetchAcrossKeys(ring, function (k) { return buildUrl(k, pr, hub); }, {}, dm);
      const r = f.r;
      debug.apiVersion = Object.assign({ pinned: API_VERSION || null, pinRejected: !!dm.pinRejected }, dm.api || {});
      Object.assign(debug, ring.used());
      debug.status = r.status;
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
      debug.topLevelKeys = json && typeof json === "object" ? Object.keys(json) : [];
      debug.num_found = json && json.num_found != null ? json.num_found : undefined;
      const rows = json && Array.isArray(json.listings) ? json.listings : [];
      debug.rawSample = rows.slice(0, 2);
      debug.normalizedSample = rows.slice(0, 2).map(function (row) { return normalize(row, pr.id); });
      // Echo the response body on error/empty so 4xx reasons (e.g. HTTP 422) are
      // visible in the app — key already redacted from `request` above.
      if (!r.ok || rows.length === 0) debug.body = text.slice(0, 1000);

      // Auto-diagnose a valid-but-empty result: re-run with progressively
      // relaxed filters to isolate which one zeroes it (budget? year? model name?).
      if (r.ok && rows.length === 0) {
        const variants = [
          { relaxed: "drop price+miles", drop: ["price_range", "miles_range"] },
          { relaxed: "drop price+miles+powertrain (keep model)", drop: ["price_range", "miles_range", "powertrain_type"] },
          { relaxed: "drop price+miles+year+powertrain", drop: ["price_range", "miles_range", "year", "powertrain_type"] },
          { relaxed: "make only (drop model+powertrain)", drop: ["price_range", "miles_range", "year", "model", "powertrain_type"] },
        ];
        debug.diagnosis = [];
        for (const v of variants) {
          await sleep(THROTTLE_MS);
          try {
            const ff = await fetchAcrossKeys(ring, function (k) {
              const u = new URL(buildUrl(k, pr, hub));
              v.drop.forEach(function (d) { u.searchParams.delete(d); });
              return u.toString();
            }, {});
            const rr = ff.r;
            const jj = await rr.json().catch(function () { return null; });
            const entry = { relaxed: v.relaxed, status: rr.status, num_found: jj && jj.num_found != null ? jj.num_found : null };
            // Whenever the powertrain filter is dropped we get real listings —
            // surface the actual model / powertrain_type / fuel_type strings so we
            // can see the exact values to filter on (instead of guessing).
            if (v.drop.indexOf("powertrain_type") > -1 && jj && Array.isArray(jj.listings)) {
              const counts = {}, pt = {}, ft = {};
              jj.listings.forEach(function (l) {
                const b = l && l.build; if (!b) return;
                if (b.model) counts[b.model] = (counts[b.model] || 0) + 1;
                if (b.powertrain_type) pt[b.powertrain_type] = (pt[b.powertrain_type] || 0) + 1;
                if (b.fuel_type) ft[b.fuel_type] = (ft[b.fuel_type] || 0) + 1;
              });
              entry.modelsSeen = counts;
              entry.powertrainsSeen = pt;
              entry.fuelTypesSeen = ft;
              const target = jj.listings.find(function (l) { return l && l.build && /rav4/i.test(l.build.model || ""); });
              entry.sampleBuild = (target || jj.listings[0] || {}).build;
            }
            debug.diagnosis.push(entry);
          } catch (e) { debug.diagnosis.push({ relaxed: v.relaxed, error: e && e.message }); }
        }
      }
    } catch (e) {
      debug.error = e && e.message ? e.message : "fetch failed";
    }
    // MarketCheck embeds the API key in media.photo_links_cached URLs — strip
    // media and redact any stray api_key so the debug output never leaks it.
    if (Array.isArray(debug.rawSample)) debug.rawSample = debug.rawSample.map(stripMedia);
    const safe = JSON.parse(JSON.stringify(debug).replace(/api_key=[^"&\\\s]+/g, "api_key=REDACTED"));
    res.status(200).json(safe);
    return;
  }

  // One sync step (src/syncPlan.js): a profile's full refresh / new-listings pass,
  // a count, or a watchlist VIN lookup. The browser sends steps one per request.
  const session = createSession(keys, { dealerType: dealerType, spentKeys: body.spentKeys, keyIds: keys.map(function (k) { return keyId(k, resolved.shared ? envKey : null); }) });
  const r = await runStep(session, {
    kind: body.kind, profile: body.profile, since: body.since, vins: body.vins, excludeSalt: body.excludeSalt !== false,
  });
  res.status(200).json(r);
}

// Index of the first key whose id isn't in `spent`. If every key is known spent we
// still try the last one (one call, which reports the reset time) rather than none.
export function firstLiveKey(ids, spent) {
  const set = {};
  (Array.isArray(spent) ? spent : []).forEach(function (id) { if (id) set[id] = true; });
  for (let i = 0; i < ids.length; i++) if (!set[ids[i]]) return i;
  return Math.max(0, ids.length - 1);
}

// ── Search session ──
// Shared state for the calls one request (or one scheduled-sync account) makes:
// the ordered keys (each its own account, moved past only when one's monthly
// quota is spent), the call meter, quota snapshots, the time budget, errors.
// opts: { keyIds, spentKeys, dealerType, budgetMs }
export function createSession(keys, opts) {
  opts = opts || {};
  const ids = Array.isArray(opts.keyIds) && opts.keyIds.length === keys.length ? opts.keyIds : keys.map(function (k) { return keyId(k, null); });
  // Start on the first key not already known to be spent (from the stored quota or
  // earlier requests of this sync), instead of paying a call to rediscover it.
  const idx = firstLiveKey(ids, opts.spentKeys);
  return {
    keys: keys, ids: ids, keyIdx: idx, keysUsed: idx + 1, meter: { calls: 0 }, snaps: {},
    errors: [], notices: [], rateLimited: false, rateLimitInfo: null, quota: null,
    dealerType: opts.dealerType || null, first: true, timeUp: false,
    // Stop issuing new calls before the 60 s function limit, returning what we have.
    deadline: Date.now() + (Number(opts.budgetMs) || Number(process.env.MARKETCHECK_BUDGET_MS) || 50000),
    rowsSeen: 0, malformed: 0, shapeless: false,
  };
}

// The session's report (what the proxy returns for a step, minus its listings).
export function sessionReport(s) {
  const formatSuspect = s.shapeless || (s.rowsSeen >= 10 && s.malformed / s.rowsSeen >= 0.5);
  const errors = s.errors.slice();
  if (formatSuspect) {
    errors.unshift("⚠ MarketCheck's response format looks changed (" + (s.shapeless ? "no listings array" : s.malformed + " of " + s.rowsSeen + " rows missing VIN/make/model")
      + ", served by " + ((s.meter.api && s.meter.api.served) || "an unknown API version") + ") — listings may be missing or wrong. Check Debug raw.");
  }
  return {
    errors: errors, notices: s.notices.slice(), rateLimited: s.rateLimited, rateLimitInfo: s.rateLimitInfo, quota: s.quota,
    keysUsed: s.keysUsed, keyQuotas: Object.keys(s.snaps).map(function (i) { return s.snaps[i]; }), calls: s.meter.calls,
    apiInfo: Object.assign({ pinned: API_VERSION || null, pinRejected: !!s.meter.pinRejected }, s.meter.api || {}),
    formatSuspect: formatSuspect,
  };
}

const num = function (v) { const n = parseFloat(v); return isFinite(n) ? n : null; };

// One page. makeUrl(key) builds the request. -> { rows, numFound } or null when the
// call failed (recorded on the session; s.timeUp / s.rateLimited say to stop).
// opts.decode: a NeoVIN decode answer (no listings array) — skip the search-shape checks.
async function getPage(s, makeUrl, label, opts) {
  while (true) {
    if (Date.now() > s.deadline) {
      if (!s.timeUp) s.errors.push("Stopped early to avoid a timeout — some results may be missing.");
      s.timeUp = true;
      return null;
    }
    if (!s.first) await sleep(THROTTLE_MS); // stay under the per-second rate limit
    s.first = false;
    const url = makeUrl(s.keys[s.keyIdx]);
    let r;
    try {
      r = await fetchWithRetry(url, {}, undefined, s.meter);
    } catch (e) {
      s.errors.push(label + ": " + (e && e.message ? e.message : "fetch failed"));
      return null;
    }
    if (!r.ok) {
      let body = "";
      try { body = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
      const q = readQuota(r, body);
      if (q) s.snaps[s.keyIdx] = Object.assign({ id: s.ids[s.keyIdx] }, q);
      // Rate limit / quota: move to the next key ONLY when this one's monthly quota
      // is spent; a throttle was already retried with backoff on this key.
      if (r.status === 429 || r.status === 503 || r.status === 402) {
        const monthlySpent = r.status === 402 || !!(s.snaps[s.keyIdx] && s.snaps[s.keyIdx].exhausted);
        if (monthlySpent && s.keyIdx + 1 < s.keys.length) {
          const spent = s.keyIdx + 1;
          s.keyIdx++;
          s.keysUsed = Math.max(s.keysUsed, s.keyIdx + 1);
          s.notices.push("Key #" + spent + " is out of monthly quota; continuing on key #" + (s.keyIdx + 1) + ".");
          continue; // same page, next key
        }
        s.rateLimited = true;
        s.timeUp = true;
        s.rateLimitInfo = {
          status: r.status, retryAfter: num(r.headers.get("retry-after")),
          rateReset: isoMcTime(r.headers.get("ratelimit-reset-time")), quotaReset: isoMcTime(r.headers.get("quota-reset-time")),
          rateRemaining: num(r.headers.get("ratelimit-remaining")), quotaRemaining: num(r.headers.get("quota-remaining")),
        };
        const whose = s.keys.length === 1 ? "your key" : "all " + s.keys.length + " keys";
        s.errors.push(monthlySpent
          ? "MarketCheck monthly quota is used up on " + whose + " (HTTP " + r.status + ") — results are incomplete; it resets with the month." + (body ? " [" + body.slice(0, 120) + "]" : "")
          : "MarketCheck is rate-limiting requests (HTTP " + r.status + ") — results are incomplete; wait a bit and sync again." + (body ? " [" + body.slice(0, 120) + "]" : ""));
        return null;
      }
      // 4xx bodies name the offending param: echo it (and the query, key redacted).
      const sent = url.split("?")[1] ? url.split("?")[1].replace(/api_key=[^&]*&?/, "") : "";
      s.errors.push(label + ": MarketCheck HTTP " + r.status + (body ? " — " + body : "") + (r.status >= 400 && r.status < 500 ? " [sent: " + sent + "]" : ""));
      return null;
    }
    const q = readQuota(r, "");
    if (q) s.snaps[s.keyIdx] = Object.assign({ id: s.ids[s.keyIdx] }, q);
    const qrem = num(r.headers.get("quota-remaining"));
    if (qrem != null) s.quota = { remaining: qrem, limit: num(r.headers.get("quota-limit")), reset: isoMcTime(r.headers.get("quota-reset-time")) };
    let json;
    try { json = await r.json(); } catch (e) { s.errors.push(label + ": unreadable response"); return null; }
    if (opts && opts.decode) return { rows: [], numFound: null, facets: null, json: json };
    if (!Array.isArray(json.listings) && json.num_found == null) s.shapeless = true;
    const rows = Array.isArray(json.listings) ? json.listings : [];
    rows.forEach(function (row) { s.rowsSeen++; if (!row || !row.vin || !row.build || !row.build.make || !row.build.model) s.malformed++; });
    return { rows: rows, numFound: typeof json.num_found === "number" ? json.num_found : null, facets: json.facets || null, stats: json.stats || null };
  }
}

// NeoVIN (MarketCheck's VIN decoder — on the free plan, one call per VIN, no batch
// form) -> the factory exterior color, for listings whose search record has none.
// Verified live: KM8JCCD10RU198791 (no color in its listing) decodes to
// "Shimmering Silver Metallic", base "Silver", confidence 0.8. No build date.
export const DECODE_ENDPOINT = "/v2/decode/car/neovin/";
export function buildDecodeUrl(apiKey, vin) {
  return HOST + DECODE_ENDPOINT + encodeURIComponent(vin) + "/specs?api_key=" + encodeURIComponent(apiKey);
}
const DECODE_MIN_CONFIDENCE = 0.5;
// A NeoVIN answer -> { color, baseColor, confidence } or null when it has no usable color.
export function decodedColor(j) {
  const c = j && j.exterior_color;
  if (!c || typeof c !== "object" || !c.base) return null;
  const conf = c.confidence != null && c.confidence !== "" ? Number(c.confidence) : null;
  if (conf != null && isFinite(conf) && conf < DECODE_MIN_CONFIDENCE) return null;
  return { color: c.name || c.base, baseColor: c.base, confidence: conf };
}

// One step -> the session report plus { listings, numFound }.
// step: { kind: "full" | "new" | "count" | "vins" | "local", profile, since, vins, excludeSalt, hub }
//   full  — every car matching the profile nationwide, plus its color breakdown
//           (a facet on page 1 — no extra call) (salt states excluded unless
//           excludeSalt === false). Over the 500-row ceiling the state list is
//           halved until each part fits; a single state still too big pages to the
//           ceiling and says so.
//   new   — newest at this dealer first (dos_active asc), stopping once a page
//           reaches cars listed more than `since` days ago.
//   count — num_found plus the color facet (rows=0): one call, no paging.
//   vins  — the listed rows for up to 50 VINs (vin= takes a list), every page.
//   local — the old radius search around one hub (Price Check's live comps).
//   decode — NeoVIN for up to 10 VINs, one call each -> { decoded: { VIN: { color, baseColor } } }.
// A page's facet for one field -> { counts: { Black: 261, … }, unlisted }
// (unlisted = matching cars not in any bucket), or null without the facet.
// Facets list at most 20 values each — `version` can overflow on a broad search,
// which is why the trim chips also offer values seen on synced cars.
function facetOf(pg, field) {
  const f = pg && pg.facets && Array.isArray(pg.facets[field]) ? pg.facets[field] : null;
  if (!f) return null;
  const counts = {};
  let total = 0;
  f.forEach(function (x) { if (x && x.item) { counts[x.item] = Number(x.count) || 0; total += counts[x.item]; } });
  return { counts: counts, unlisted: pg.numFound != null ? Math.max(0, pg.numFound - total) : null };
}
function colorsOf(pg) { return facetOf(pg, "base_exterior_color"); }
// Every facet a profile's chips use, asked for together (verified live, Oct 2026:
// one call returns all three — Outback: 9 versions, Tucson Hybrid: 1 drivetrain).
export const PROFILE_FACETS = "base_exterior_color,version,drivetrain";
function profileFacetsOf(pg) {
  return { colors: colorsOf(pg), trims: facetOf(pg, "version"), drivetrains: facetOf(pg, "drivetrain") };
}
// A stats block (stats=price,miles) trimmed to what the profile wizard uses:
// { min, max, mean, median, count, missing, percentiles: { "5.0": …, "99.0": … } }.
function statOf(st) {
  if (!st || typeof st !== "object") return null;
  const n = function (v) { const x = Number(v); return isFinite(x) ? x : null; };
  const pc = {};
  Object.keys(st.percentiles || {}).forEach(function (k) { const v = n(st.percentiles[k]); if (v != null) pc[k] = v; });
  return { min: n(st.min), max: n(st.max), mean: n(st.mean), median: n(st.median), count: n(st.count), missing: n(st.missing), percentiles: pc };
}

export async function runStep(s, step) {
  step = step || {};
  const profile = step.profile && step.profile.params ? step.profile : null;
  const seen = {};
  let numFound = null;
  let years = null, stats = null; // count step only: the year facet + price/miles stats (the profile wizard)
  let facets = { colors: null, trims: null, drivetrains: null }; // count / full page 1: { counts: { Black: 261, … }, unlisted: 34 } each
  const keep = function (row) {
    const norm = normalize(row, profile ? profile.id : null);
    if (!norm || !norm.vin) return;
    if (s.dealerType === "franchise" && norm.dealerType !== "franchise") return; // backstop the filter
    const prev = seen[norm.vin];
    if (!prev || (norm.price && (!prev.price || norm.price < prev.price))) seen[norm.vin] = norm;
  };
  const label = (profile ? (profile.name || profile.id) : "watchlist") + " [" + (step.kind || "?") + "]";
  const states = searchStates(step.excludeSalt !== false);
  const nat = function (extra) {
    return function (k, start) { return buildUrl(k, profile, { national: true }, start, "used", s.dealerType, extra); };
  };

  // Page a query to the end (or the ceiling). Returns numFound or null on failure.
  async function pageAll(make, maxRows) {
    let start = 0, found = null;
    while (start < maxRows) {
      const pg = await getPage(s, function (k) { return make(k, start); }, label);
      if (!pg) return null;
      if (found == null) found = pg.numFound;
      pg.rows.forEach(keep);
      if (pg.rows.length < ROWS || (pg.numFound != null && start + ROWS >= pg.numFound)) break;
      start += ROWS;
    }
    return found;
  }
  // Full refresh over a list of states, halving it while the result is too big.
  async function fullOver(list) {
    const make = nat({ state: list.join(",") });
    // The top-level page 1 also asks for the color / trim / drivetrain breakdown of
    // the whole match set (facets: same call, nothing extra), so each full refresh
    // keeps the profile's chips current.
    const top = list === states;
    const p1 = await getPage(s, function (k) { const u = make(k, 0); return top ? u + "&facets=" + PROFILE_FACETS : u; }, label);
    if (!p1) return null;
    if (top) facets = profileFacetsOf(p1);
    p1.rows.forEach(keep);
    const n = p1.numFound;
    if (n != null && n > PAGE_LIMIT && list.length > 1) {
      const half = Math.ceil(list.length / 2);
      const a = await fullOver(list.slice(0, half));
      if (a == null) return null;
      const b = await fullOver(list.slice(half));
      return b == null ? null : n;
    }
    if (n != null && n > PAGE_LIMIT) s.notices.push(label + ": " + n + " cars in " + list[0] + " alone — only the newest " + PAGE_LIMIT + " were read. Narrow the profile (price, miles or years).");
    if (p1.rows.length >= ROWS && (n == null || n > ROWS)) {
      let start = ROWS;
      while (start < Math.min(PAGE_LIMIT, n == null ? PAGE_LIMIT : n)) {
        const pg = await getPage(s, function (k) { return make(k, start); }, label);
        if (!pg) return null;
        pg.rows.forEach(keep);
        if (pg.rows.length < ROWS) break;
        start += ROWS;
      }
    }
    return n;
  }

  if (step.kind === "decode") {
    const vins = (Array.isArray(step.vins) ? step.vins : []).map(function (v) { return String(v || "").trim().toUpperCase(); }).filter(function (v) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(v); }).slice(0, 10);
    const decoded = {};
    for (const v of vins) {
      const before = s.errors.length;
      const pg = await getPage(s, function (k) { return buildDecodeUrl(k, v); }, "decode " + v, { decode: true });
      if (!pg) {
        if (s.timeUp || s.rateLimited) break;
        // A VIN NeoVIN can't decode isn't a sync error: remember "no color" and move on.
        s.errors.splice(before);
        decoded[v] = null;
        continue;
      }
      decoded[v] = decodedColor(pg.json); // null = decoded, but no usable color (remembered too)
    }
    return Object.assign(sessionReport(s), { listings: [], numFound: null, decoded: decoded });
  } else if (step.kind === "vins") {
    const vins = (Array.isArray(step.vins) ? step.vins : []).map(function (v) { return String(v || "").trim().toUpperCase(); }).filter(Boolean).slice(0, 50);
    if (vins.length) await pageAll(function (k, start) { return buildVinUrl(k, vins.join(","), start); }, PAGE_LIMIT);
  } else if (!profile) {
    s.errors.push("No profile to search");
  } else if (step.kind === "count") {
    // Plus the color / trim / drivetrain / year breakdown across the whole match
    // set and its price + mileage spread (facets + stats: same call, no paging).
    // Verified live to list every base color (11 for Outback, Purple: 1) and to
    // return percentiles on the free plan.
    const pg = await getPage(s, function (k) { return nat({ state: states.join(","), rows: "0", facets: PROFILE_FACETS + ",year", stats: "price,miles" })(k, 0); }, label);
    if (pg) {
      numFound = pg.numFound;
      facets = profileFacetsOf(pg);
      years = facetOf(pg, "year");
      stats = pg.stats ? { price: statOf(pg.stats.price), miles: statOf(pg.stats.miles) } : null;
    }
  } else if (step.kind === "new") {
    const since = Math.max(1, Number(step.since) || 1);
    const make = nat({ state: states.join(","), sort_by: "dos_active", sort_order: "asc" });
    let start = 0;
    while (start < PAGE_LIMIT) {
      const pg = await getPage(s, function (k) { return make(k, start); }, label);
      if (!pg) break;
      if (numFound == null) numFound = pg.numFound;
      pg.rows.forEach(keep);
      const last = pg.rows[pg.rows.length - 1];
      const lastDays = last && last.dos_active != null ? Number(last.dos_active) : null;
      if (pg.rows.length < ROWS || (pg.numFound != null && start + ROWS >= pg.numFound)) break;
      if (lastDays == null || lastDays > since) break; // past the cars new since the last search
      start += ROWS;
    }
  } else if (step.kind === "local") {
    const hub = step.hub || {};
    numFound = await pageAll(function (k, start) { return buildUrl(k, profile, hub, start, "used", s.dealerType); }, Math.min(PAGE_LIMIT, MAX_ROWS));
  } else {
    numFound = await fullOver(states);
  }
  return Object.assign(sessionReport(s), { listings: Object.values(seen), numFound: numFound, colors: facets.colors, trims: facets.trims, drivetrains: facets.drivetrains, years: years, stats: stats });
}

// ── MarketCheck query construction ──
// One VIN, any car_type (a VIN may be listed under more than one).
// `vin` may be a comma-separated list (verified live): the watchlist lookup.
export function buildVinUrl(apiKey, vin, start) {
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  q.set("vin", vin);
  q.set("rows", String(ROWS));
  if (start) q.set("start", String(start));
  return HOST + ENDPOINT + "?" + q.toString();
}

// Every price-related field on a raw record, side by side, plus who/when — the
// docs say last_seen_at_date is the last time the car was active at this price.
export function priceFacts(row) {
  row = row || {};
  const dealer = row.dealer || {};
  return {
    price: row.price != null ? row.price : null,
    msrp: row.msrp != null ? row.msrp : null,
    ref_price: row.ref_price != null ? row.ref_price : null,
    price_change_percent: row.price_change_percent != null ? row.price_change_percent : null,
    first_seen_at_date: row.first_seen_at_date || row.scraped_at_date || null,
    last_seen_at_date: row.last_seen_at_date || null,
    inventory_type: row.inventory_type || null,
    seller_type: row.seller_type || null,
    source: row.source || null,
    dealer: dealer.name || null,
    vdp_url: row.vdp_url || null,
  };
}
// `extra` sets or overrides params (state, sort_by/sort_order, rows).
export function buildUrl(apiKey, profile, hub, start, carType, dealerType, extra) {
  const p = profile.params || {};
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  // car_type=used includes certified pre-owned (see the car_type note up top).
  q.set("car_type", carType || "used");
  // Optional dealer-type narrowing (e.g. "franchise" to exclude independents).
  if (dealerType) q.set("dealer_type", dealerType);
  if (p.make) q.set("make", p.make);
  if (p.model) q.set("model", p.model);
  if (p.powertrain) q.set("powertrain_type", mapPowertrain(p.powertrain));
  // Exact years (CSV) rather than a min-max range, so a non-contiguous profile
  // like "2016, 2018" excludes the gap year (2017) instead of over-fetching it.
  const years = parseYears(p.years).split(",").filter(Boolean);
  if (years.length) q.set("year", years.join(","));
  if (p.maxPrice) q.set("price_range", "0-" + Math.round(p.maxPrice));
  if (p.maxMiles) q.set("miles_range", "0-" + Math.round(p.maxMiles));
  // Prefer lat/long (independent of MarketCheck's ZIP index — some valid ZIPs
  // like 02101 are "not found"); fall back to zip.
  // A nationwide search (hub.national) sends no location at all — verified live:
  // the free plan answers it, with dealer coordinates on every row but no `dist`.
  hub = hub || { national: true };
  if (!hub.national) {
    if (hub.lat != null && hub.lon != null) {
      q.set("latitude", String(hub.lat));
      q.set("longitude", String(hub.lon));
    } else if (hub.z) {
      q.set("zip", hub.z);
    }
    q.set("radius", String(hub.r || RADIUS_MI));
  }
  q.set("rows", String(ROWS));
  q.set("start", String(start || 0));
  // Most recently (re)crawled first: the newest data, so a search cut off at the
  // pagination ceiling keeps the freshest cars.
  q.set("sort_by", "last_seen");
  q.set("sort_order", "desc");
  Object.keys(extra || {}).forEach(function (k) { if (extra[k] != null) q.set(k, String(extra[k])); });
  return HOST + ENDPOINT + "?" + q.toString();
}



// Only http(s) URLs may flow into the app (they're rendered as <a href> /
// <img src> in the client) — anything else (javascript:, data:, …) is dropped.
export function safeHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : "";
}

// ── MarketCheck listing -> app listing shape ──
export function normalize(row, profileId) {
  if (!row || typeof row !== "object") return null;
  const build = row.build || {};
  const dealer = row.dealer || {};
  const vehicle = ((build.make || "") + " " + (build.model || "")).trim();
  // Some dealer feeds quote a price that already includes fees (doc fee etc.),
  // flagged by price_includes_fees. Others quote it before fees. Store the
  // price BEFORE fees either way — it's what the dealer's site headlines — and
  // keep the fee separately, so cars from different feeds compare like-for-like.
  const quoted = Number(row.price) || 0;
  const feeAmt = Number(row.fees) > 0 ? Number(row.fees) : 0;
  const price = quoted && feeAmt && row.price_includes_fees === true && quoted > feeAmt ? quoted - feeAmt : quoted;
  const coord = function (v) { const n = parseFloat(v); return isFinite(n) ? n : null; };
  return {
    vin: row.vin || "",
    vehicle: vehicle,
    year: Number(build.year) || 0,
    // version is the fuller variant (e.g. "Hybrid LE AWD") — surfaces the
    // powertrain on the card; fall back to the plain trim. MarketCheck writes "-"
    // for "no version" (every Outback Base) — that's no version, not a trim.
    trim: (build.version && build.version !== "-" ? build.version : "") || build.trim || "",
    // "4WD" (MarketCheck's word for AWD too), "FWD", "RWD" — per-profile chips.
    drivetrain: build.drivetrain || null,
    price: price,
    fees: feeAmt || null,
    mileage: Number(row.miles) || 0,
    dealer: dealer.name || "",
    dealerType: mapDealerType(row, dealer),
    // Certified Pre-Owned is orthogonal to dealer type (a CPO car is still sold
    // by a franchise dealer), so it's its own signal — manufacturer-backed
    // inspection + warranty, a strong positive the AI scores on directly.
    cpo: isCpo(row),
    location: dealer.city || "",
    state: dealer.state || "",
    color: row.exterior_color || "",
    // MarketCheck's normalized color ("Black", "Gray"…) — what per-profile color
    // filters match on (src/colors.js). null when the listing has no color at all.
    baseColor: row.base_ext_color || null,
    link: safeHttpUrl(row.vdp_url),
    photo: pickPhoto(row),
    // Days listed at THIS source, active stretch only (dos_active). MarketCheck's
    // plain `dom` counts across earlier listings of the same car (a Tucson showed
    // dom 109 vs dos_active 67 — the latter matched the dealer's own listing date).
    dom: row.dos_active != null ? Number(row.dos_active) : row.dom_active != null ? Number(row.dom_active) : null,
    // Dealer coordinates -> true miles from the buyer's home base (src/geo.js).
    dLat: coord(dealer.latitude),
    dLon: coord(dealer.longitude),
    // When MarketCheck last saw this car at this price (YYYY-MM-DD). Distinct from
    // our own lastSeen (the day WE synced): a stale crawl hides behind a fresh sync.
    mcSeen: typeof row.last_seen_at_date === "string" && row.last_seen_at_date.length >= 10 ? row.last_seen_at_date.slice(0, 10) : null,
    // Miles from the search location (MarketCheck returns `dist` on geo/zip
    // queries) — surfaced on cards and fed to the "location" scoring criterion.
    distMi: row.dist != null && !isNaN(Number(row.dist)) ? Math.round(Number(row.dist)) : null,
    // Extras that feed AI scoring (and persist on the listing). MarketCheck puts
    // these at the row top level; null when absent so scoring can tell "unknown"
    // from a real false/0. msrp on used inventory often just echoes the asking
    // price, so the scoring prompt only surfaces it when it exceeds price.
    carfax_1_owner: typeof row.carfax_1_owner === "boolean" ? row.carfax_1_owner : null,
    carfax_clean_title: typeof row.carfax_clean_title === "boolean" ? row.carfax_clean_title : null,
    price_change_percent: row.price_change_percent != null ? Number(row.price_change_percent) : null,
    msrp: Number(row.msrp) || 0,
    profileId: profileId,
    source: "marketcheck",
  };
}

// First usable dealer photo (media.photo_links — NOT photo_links_cached, which
// embeds the API key). Skips "coming soon"/placeholder images and caps the
// width on Cloudflare-style transform URLs (e.g. ".../w_900/..." -> w_400) so
// we hotlink a thumbnail, not a full-res image.
export function pickPhoto(row) {
  const media = row && row.media;
  const links = media && Array.isArray(media.photo_links) ? media.photo_links : [];
  for (const u of links) {
    if (!safeHttpUrl(u)) continue;
    if (/coming.?soon|no.?image|placeholder/i.test(u)) continue;
    return u.replace(/([?&/,]w_)(\d+|auto)/i, "$1400");
  }
  return "";
}

// CPO is now tracked as its own `cpo` boolean (see normalize); dealer type keeps
// the actual seller category so a CPO franchise car still reads as "franchise".
export function mapDealerType(row, dealer) {
  const dt = String(dealer.dealer_type || row.seller_type || "").toLowerCase();
  if (dt.indexOf("independ") > -1) return "independent";
  if (dt.indexOf("private") > -1) return "private";
  return "franchise";
}

// MarketCheck flags certified inventory with is_certified (value 1; the field is
// only present on certified cars). car_type=used returns certified cars too, so
// this is how a used result gets labelled CPO.
export function isCpo(row) {
  return !!row && (row.is_certified === 1 || row.is_certified === "1" || row.is_certified === true);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// Drop the bulky `media` block (its cached-image URLs embed the API key).
function stripMedia(row) {
  if (!row || typeof row !== "object") return row;
  const c = Object.assign({}, row);
  delete c.media;
  return c;
}

// ── Mock data (?mock=1): two synthetic listings per active profile ──
function mockListings(profiles, hubs) {
  const hub = (hubs && hubs[0]) || {};
  const hubName = hub.n || hub.z || "Durham NC"; // a hub may carry only a ZIP
  const out = [];
  (profiles || []).forEach(function (pr, i) {
    const p = pr.params || {};
    const baseYear = parseInt(parseYears(p.years).split(",")[0], 10) || 2021;
    const maxP = p.maxPrice || 20000;
    for (let k = 0; k < 2; k++) {
      const slug = String(pr.id || i).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      out.push({
        vin: "MOCK" + slug + k,
        vehicle: ((p.make || "") + " " + (p.model || "")).trim(),
        year: baseYear + k,
        trim: (p.trims || "").split(",")[0].trim(),
        price: Math.max(5000, maxP - 1500 - k * 1200),
        mileage: 40000 + k * 9000,
        dealer: "Mock Motors " + (k + 1),
        dealerType: k === 0 ? "franchise" : "independent",
        cpo: k === 0,
        location: hubName.split(" ")[0],
        state: hubName.slice(-2),
        color: k === 0 ? "Silver" : "Blue",
        link: "",
        dom: 12 + k * 7,
        profileId: pr.id,
        source: "marketcheck",
      });
    }
  });
  return out;
}
