// Serverless proxy for MarketCheck active-inventory search.
//
// Holds MARKETCHECK_API_KEY (server-side only) and translates the app's active
// vehicle profiles into MarketCheck queries, returning listings normalized to
// the app's shape. The browser never sees the key.
//
// Request:  POST { profiles: [{ id, name, params }], hubs: [{ n, z }] }
// Response: { listings: [<normalized>], errors: [<string>], mock?: true }
//
// Param/response field names follow the MarketCheck Cars API v2
// (GET /v2/search/car/active) and are isolated in buildUrl()/normalize() so any
// API drift is a one-file change. Pass ?mock=1 to get synthetic data for
// exercising the full sync → candidate → approve flow without calling
// MarketCheck (and before the live field mapping is confirmed). Pass ?raw=1 to
// run one real query and return the raw MarketCheck response + how normalize()
// maps it, for confirming live field names (API key redacted from the echo).

import { authorize } from "./_auth.js";
import { mapPowertrain, parseYears, groupProfiles, mergedProfile, attributeRow } from "../src/queryPlan.js";
import { haversineMi } from "../src/geo.js";

export { mapPowertrain, parseYears };

const HOST = process.env.MARKETCHECK_HOST || "https://api.marketcheck.com";
const ENDPOINT = "/v2/search/car/active";
// Free tier caps radius at 100mi; override with MARKETCHECK_RADIUS on a paid
// plan. A hub may also carry its own `r` to override per-location.
const RADIUS_MI = Number(process.env.MARKETCHECK_RADIUS) || 100;
const ROWS = 50; // page size per request
// Paginate up to this many rows per profile×hub, so a dense query (e.g. a
// popular model in a big metro) doesn't silently drop everything past the first
// page and flag still-active listings as "not seen". Bounded to keep free-tier
// API usage in check; override with MARKETCHECK_MAX_ROWS on a paid plan.
const MAX_ROWS = Number(process.env.MARKETCHECK_MAX_ROWS) || 200;
// Only car_type=used is queried: it already includes certified pre-owned. Verified
// against the live API (Oct 2026, 2021-22 RAV4 within 100 mi of Durham): used=167,
// used+exclude_certified=156, certified=11 — so a separate certified query just
// paid again for the same 11 cars. CPO is still detected per row (isCpo).
const CAR_TYPES = ["used"];
// The account's pagination ceiling (start + rows); beyond it MarketCheck answers
// 422 "Subscribed package pagination limit of 500 rows exceeded" — and still
// charges the call.
const PAGE_LIMIT = Number(process.env.MARKETCHECK_PAGE_LIMIT) || 500;
// Free tier rate-limits bursts; space sequential queries out and retry 429s.
const THROTTLE_MS = Number(process.env.MARKETCHECK_THROTTLE_MS) || 500;
const MAX_RETRIES = 3;

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
    const r = await fetch(url, withVersion(opts, pin));
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
  const reset = h("quota-reset-time") || null;
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
    res.status(200).json({ listings: mockListings(profiles, hubs), errors: [], mock: true });
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
    const pr = profiles[0];
    const hub = hubs[0];
    if (!pr || !hub) {
      res.status(400).json({ error: "raw mode needs at least one profile and one hub" });
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

  const r = await searchListings(apiKey, profiles, hubs, { dealerType: dealerType, keys: keys, fingerprints: body.fingerprints, spentKeys: body.spentKeys, national: body.national === "only" ? "only" : !!body.national, keyIds: keys.map(function (k) { return keyId(k, resolved.shared ? envKey : null); }) });
  res.status(200).json({ listings: r.listings, errors: r.errors, notices: r.notices, rateLimited: !!r.rateLimited, rateLimitInfo: r.rateLimitInfo || null, quota: r.quota || null, keysUsed: r.keysUsed, keyQuotas: r.keyQuotas || [], calls: r.calls || 0, apiInfo: r.apiInfo, formatSuspect: !!r.formatSuspect, fingerprints: r.fingerprints, unchanged: r.unchanged, queries: r.queries, localProfiles: r.localProfiles });
}

// Core active-inventory search for a set of profiles × hubs — shared by the
// HTTP handler above and the scheduled background sync (api/cron-sync.js).
// opts: { dealerType, budgetMs }. Returns { listings: [<normalized>], errors }.
// ── Unchanged-search short-circuit ──
// Every call is billed (a 304 too), so page 1 is always fetched. But with results
// sorted by last_seen desc, an identical page 1 (num_found + its cars) means the
// whole result set is unchanged, so pages 2+ can be skipped. We fingerprint page 1
// ourselves rather than use the ETag, to leave out fields that drift without any
// real change (days-on-market counters, etc.); rows are ordered by VIN first, so a
// reshuffle of tied timestamps can't look like a change.
function fnv(s) {
  let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}
// Stable id for one search (everything but the key and page offset, plus the
// pinned API version), so editing a profile or location starts a fresh one.
export function searchKey(profile, hub, carType, dealerType) {
  const q = new URLSearchParams(buildUrl("", profile, hub, 0, carType, dealerType).split("?")[1]);
  q.delete("api_key"); q.delete("start");
  const parts = [];
  q.forEach(function (v, k) { parts.push(k + "=" + v); });
  // A nationwide search keeps only the cars near your locations, so which
  // locations (and radii) is part of what it returns.
  if (hub && hub.national) parts.push("hubs=" + (hub.sig || ""));
  return "q" + fnv(parts.sort().join("&") + "|" + API_VERSION);
}
export function pageFingerprint(numFound, rows) {
  const items = (rows || []).map(function (r) {
    r = r || {};
    return [r.vin || "", r.price != null ? r.price : "", r.miles != null ? r.miles : "", r.last_seen_at != null ? r.last_seen_at : ""].join(":");
  }).sort();
  return fnv(String(numFound) + "|" + items.join(","));
}

// Index of the first key whose id isn't in `spent`. If every key is known spent we
// still try the last one (one call, which reports the reset time) rather than none.
export function firstLiveKey(ids, spent) {
  const set = {};
  (Array.isArray(spent) ? spent : []).forEach(function (id) { if (id) set[id] = true; });
  for (let i = 0; i < ids.length; i++) if (!set[ids[i]]) return i;
  return Math.max(0, ids.length - 1);
}

// ── Nationwide search ──
// Per-location searches cost at least one call per location. When a search's
// whole nationwide result fits in the pagination ceiling it's cheaper to page it
// once with no location and keep the cars within a location's radius by dealer
// coordinates: at most 10 pages for any number of locations. Only possible when
// every location has coordinates.
export function hubsSig(hubs) {
  return (hubs || []).map(function (h) { return [h.lat, h.lon, h.r || RADIUS_MI].join(":"); }).sort().join(";");
}
export function geoHubs(hubs) {
  return (hubs || []).length > 0 && hubs.every(function (h) { return isFinite(parseFloat(h && h.lat)) && isFinite(parseFloat(h && h.lon)); });
}
// Nearest location whose radius covers the dealer -> whole miles, or null (outside
// every location, or the row has no dealer coordinates).
export function nearestHubMi(lat, lon, hubs) {
  if (lat == null || lon == null) return null;
  let best = null;
  (hubs || []).forEach(function (h) {
    const d = haversineMi(parseFloat(h.lat), parseFloat(h.lon), lat, lon);
    if (d <= (Number(h.r) || RADIUS_MI) && (best == null || d < best)) best = d;
  });
  return best == null ? null : Math.round(best);
}

export async function searchListings(apiKey, profiles, hubs, opts) {
  opts = opts || {};
  const dealerType = opts.dealerType || null;
  // Ordered keys (each its own MarketCheck account, so each its own monthly
  // quota); we move to the next only when one's monthly quota is spent.
  const keys = (Array.isArray(opts.keys) && opts.keys.length) ? opts.keys : [apiKey];
  const meter = { calls: 0 }; // HTTP requests actually sent — the true quota cost
  const snaps = {}; // key index -> latest { id, remaining, limit, reset, exhausted }
  const ids = Array.isArray(opts.keyIds) && opts.keyIds.length === keys.length ? opts.keyIds : keys.map(function (k) { return keyId(k, null); });
  // Start on the first key not already known to be spent (opts.spentKeys = ids, from
  // earlier requests of this sync or the stored quota) — otherwise every request of
  // a per-location sync would pay one call to rediscover that key #1 is used up.
  let keyIdx = firstLiveKey(ids, opts.spentKeys);
  let keysUsed = keyIdx + 1; // how many keys we ended up drawing on (for reporting)
  const notices = []; // informational (key failover), not errors
  const note = function (idx, r, bodyText) { const q = readQuota(r, bodyText); if (q) snaps[idx] = Object.assign({ id: ids[idx] }, q); };
  const seen = {}; // vin -> normalized listing (dedup across hubs, keep lowest price)
  const errors = [];
  let queries = 0, splits = 0;
  // Unchanged-search short-circuit: page-1 fingerprints from the last sync, the
  // ones we record this time, the searches found unchanged, and which searches
  // returned each car (so reconcile can leave an unchanged search's cars alone).
  const prior = opts.fingerprints && typeof opts.fingerprints === "object" ? opts.fingerprints : {};
  const fingerprints = {}, unchanged = [], tags = {};
  // Drift guard: rows missing the fields every listing must have. A burst of these
  // means MarketCheck's response shape changed under us (e.g. a new major version),
  // which would otherwise just drop listings silently.
  let rowsSeen = 0, malformed = 0, shapeless = false;

  // Stop issuing new queries before the function wall so we return partial
  // results instead of a 504. The client already splits by hub, so this is a
  // backstop for a single dense hub (nationwide radius × many profiles/pages).
  const deadline = Date.now() + (Number(opts.budgetMs) || Number(process.env.MARKETCHECK_BUDGET_MS) || 50000);
  const num = function (v) { const n = parseFloat(v); return isFinite(n) ? n : null; };
  let timeUp = false;
  let rateLimited = false; // set on a 429/503/402 so the caller can warn clearly
  let rateLimitInfo = null; // reset/remaining headers from MarketCheck, when present
  let quota = null; // monthly quota snapshot from response headers (for a low-quota warning)
  let first = true;

  // One query (group × hub × car type), paged. onRow gets each raw row.
  // A merged group may page up to MAX_ROWS per profile (never past the account's
  // pagination ceiling). Merging can't cost more than separate queries —
  // ceil((a+b)/50) <= ceil(a/50) + ceil(b/50) — unless it has to be split: when a
  // merged group matches more than its cap we return "split" and the caller
  // re-runs its profiles one by one (each then capped at MAX_ROWS, as before).
  // Returns { s, key, fp, numFound } where s is done | split | unchanged |
  // unchanged-split | error | stop.
  async function runQuery(group, hub, carType, onRow) {
    const pr = mergedProfile(group);
    const label = (pr.name || pr.id || "?") + " @ " + (hub.national ? "nationwide" : (hub.n || hub.z || "?")) + " [" + carType + "]";
    // Nationwide pages the whole result (that's the point); per location it's capped.
    const cap = hub.national ? PAGE_LIMIT : Math.min(PAGE_LIMIT, MAX_ROWS * group.length);
    const key = searchKey(pr, hub, carType, dealerType);
    const res = function (s, extra) { return Object.assign({ s: s, key: key }, extra || {}); };
    let fp = null;
    queries++;
    let start = 0;
    while (start < cap) {
      if (Date.now() > deadline) {
        errors.push("Stopped early to avoid a timeout — some results may be missing. Use fewer locations, a smaller radius, or narrower filters.");
        timeUp = true;
        return res("stop");
      }
      if (!first) await sleep(THROTTLE_MS); // stay under the burst rate limit
      first = false;
      try {
        const url = buildUrl(keys[keyIdx], pr, hub, start, carType, dealerType);
        const r = await fetchWithRetry(url, {}, undefined, meter);
        if (!r.ok) {
          let body = "";
          try { body = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
          note(keyIdx, r, body);
          // Rate limit / quota. Move to the next key ONLY when this one's monthly
          // quota is spent; a throttle was already
          // retried with backoff on THIS key, so reaching here means it persisted.
          if (r.status === 429 || r.status === 503 || r.status === 402) {
            const monthlySpent = r.status === 402 || !!(snaps[keyIdx] && snaps[keyIdx].exhausted);
            if (monthlySpent && keyIdx + 1 < keys.length) {
              const spent = keyIdx + 1; // 1-based index of the key whose quota is used up
              keyIdx++;
              keysUsed = Math.max(keysUsed, keyIdx + 1);
              notices.push("Key #" + spent + " is out of monthly quota; continuing on key #" + (keyIdx + 1) + ".");
              continue; // retry same page with the next key (no start advance)
            }
            rateLimited = true;
            timeUp = true;
            rateLimitInfo = {
              status: r.status,
              retryAfter: num(r.headers.get("retry-after")),
              rateReset: r.headers.get("ratelimit-reset-time") || null,
              quotaReset: r.headers.get("quota-reset-time") || null,
              rateRemaining: num(r.headers.get("ratelimit-remaining")),
              quotaRemaining: num(r.headers.get("quota-remaining")),
            };
            const whose = keys.length === 1 ? "your key" : "all " + keys.length + " keys";
            errors.push(monthlySpent
              ? "MarketCheck monthly quota is used up on " + whose + " (HTTP " + r.status + ") — results are incomplete; it resets with the month." + (body ? " [" + body.slice(0, 120) + "]" : "")
              : "MarketCheck is rate-limiting requests (HTTP " + r.status + ") — results are incomplete; wait a bit and sync again." + (body ? " [" + body.slice(0, 120) + "]" : ""));
            return res("stop");
          }
          // Auto-debug: 4xx bodies name the offending param. Echo it (+ the
          // sent query, key redacted) so the error itself is actionable.
          const sent = url.split("?")[1] ? url.split("?")[1].replace(/api_key=[^&]*&?/, "") : "";
          errors.push(label + ": MarketCheck HTTP " + r.status + (body ? " — " + body : "") + (r.status >= 400 && r.status < 500 ? " [sent: " + sent + "]" : ""));
          return res("error");
        }
        note(keyIdx, r, "");
        const qrem = num(r.headers.get("quota-remaining"));
        if (qrem != null) quota = { remaining: qrem, limit: num(r.headers.get("quota-limit")), reset: r.headers.get("quota-reset-time") || null };
        const json = await r.json();
        const numFound = typeof json.num_found === "number" ? json.num_found : null;
        if (!Array.isArray(json.listings) && json.num_found == null) shapeless = true;
        const rows = Array.isArray(json.listings) ? json.listings : [];
        rows.forEach(function (row) { rowsSeen++; if (!row || !row.vin || !row.build || !row.build.make || !row.build.model) malformed++; });
        rows.forEach(function (row) { onRow(row, key); });
        if (hub.national && start === 0) {
          // Worth it only when it all fits AND costs no more than the per-location
          // floor (one call per location, plus this page we've already paid for).
          const big = numFound == null || numFound > PAGE_LIMIT || Math.ceil(numFound / ROWS) > hubs.length + 1;
          fp = pageFingerprint(numFound, rows);
          if (!big && prior[key] && prior[key] === fp) return res("unchanged", { fp: fp });
          if (big) return res(group.length > 1 ? "split" : "local", { fp: fp });
        }
        const tooBig = !hub.national && group.length > 1 && numFound != null && numFound > cap;
        if (start === 0 && !hub.national) {
          fp = pageFingerprint(numFound, rows);
          // Same page 1 as last time -> the whole result set is unchanged: stop here.
          if (prior[key] && prior[key] === fp) return res(tooBig ? "unchanged-split" : "unchanged", { fp: fp });
        }
        // A merged query too big to page completely: run its profiles separately
        // (this page's rows are already kept — dedupe handles the overlap).
        if (start === 0 && tooBig) return res("split", { fp: fp });
        if (rows.length < ROWS || (numFound != null && start + ROWS >= numFound)) return res("done", { fp: fp });
        start += ROWS;
      } catch (e) {
        errors.push(label + ": " + (e && e.message ? e.message : "fetch failed"));
        return res("error");
      }
    }
    return res("done", { fp: fp });
  }

  function keep(row, group, key, national) {
    const p = attributeRow(row, group);
    if (!p) return null; // matched only the merged union of filters, not any one profile
    const norm = normalize(row, p.id);
    if (!norm || !norm.vin) return null;
    if (national) {
      // Nationwide rows: keep only cars within one of your locations' radius.
      const mi = nearestHubMi(norm.dLat, norm.dLon, hubs);
      if (mi == null) return null;
      norm.distMi = mi;
    }
    // Backstop the dealer_type filter in case the API returns extras.
    if (dealerType === "franchise" && norm.dealerType !== "franchise") return null;
    const prev = seen[norm.vin];
    // Lowest REAL price wins — a priced row always beats an unpriced one.
    if (!prev || (norm.price && (!prev.price || norm.price < prev.price))) seen[norm.vin] = norm;
    if (key) (tags[norm.vin] = tags[norm.vin] || {})[key] = true; // which searches returned this car
    return norm;
  }

  // One search (and any per-profile splits of it). Profiles a nationwide search
  // can't cover go to `local`. Returns false when the run must stop.
  async function runPlan(group, hub, carType, local) {
    const queue = [{ g: group, parent: null }];
    while (queue.length) {
      const item = queue.shift();
      const g = item.g;
      const out = await runQuery(g, hub, carType, function (row, key) { keep(row, g, key, !!hub.national); });
      const parent = item.parent;
      if (out.s === "local") g.forEach(function (p) { local[p.id] = p; });
      if (out.s === "done" || out.s === "unchanged") fingerprints[out.key] = out.fp;
      if (out.s === "unchanged") unchanged.push(out.key);
      if (out.s === "unchanged-split") {
        // The whole merged set is unchanged, so its per-profile searches are too.
        fingerprints[out.key] = out.fp;
        unchanged.push(out.key);
        g.forEach(function (p) {
          const k = searchKey(mergedProfile([p]), hub, carType, dealerType);
          unchanged.push(k);
          if (prior[k]) fingerprints[k] = prior[k];
        });
      }
      // A split's own fingerprint only counts once every per-profile search finished.
      if (out.s === "split") {
        splits++;
        const rec = { key: out.key, fp: out.fp, left: g.length, failed: false };
        g.forEach(function (p) { queue.push({ g: [p], parent: rec }); });
      }
      if (parent) {
        if (out.s !== "done" && out.s !== "unchanged") parent.failed = true;
        if (--parent.left === 0 && !parent.failed) fingerprints[parent.key] = parent.fp;
      }
      if (out.s === "stop") return false;
    }
    return !timeUp;
  }

  // Nationwide first (when asked and possible), then per location for whatever it
  // couldn't cover. opts.national === "only" stops after the nationwide pass and
  // reports the rest in `localProfiles`, so the browser can run them one location
  // per request (each its own function invocation, clear of the timeout).
  let local = {};
  let national = 0;
  let go = true;
  if (opts.national && hubs.length > 1 && geoHubs(hubs)) {
    const nat = { national: true, sig: hubsSig(hubs) };
    for (const group of groupProfiles(profiles)) {
      for (const carType of CAR_TYPES) {
        national++;
        if (!(go = await runPlan(group, nat, carType, local))) break;
      }
      if (!go) break;
    }
  } else {
    (profiles || []).forEach(function (p) { if (p) local[p.id] = p; });
  }
  const localList = (profiles || []).filter(function (p) { return p && local[p.id]; });
  if (go && opts.national !== "only") {
    outer:
    for (const group of groupProfiles(localList)) {
      for (const hub of hubs) {
        for (const carType of CAR_TYPES) {
          if (!(await runPlan(group, hub, carType, {}))) break outer;
        }
      }
    }
  }

  const formatSuspect = shapeless || (rowsSeen >= 10 && malformed / rowsSeen >= 0.5);
  if (formatSuspect) {
    errors.unshift("⚠ MarketCheck's response format looks changed (" + (shapeless ? "no listings array" : malformed + " of " + rowsSeen + " rows missing VIN/make/model")
      + ", served by " + ((meter.api && meter.api.served) || "an unknown API version") + ") — listings may be missing or wrong. Check Debug raw.");
  }
  return {
    formatSuspect: formatSuspect,
    apiInfo: Object.assign({ pinned: API_VERSION || null, pinRejected: !!meter.pinRejected }, meter.api || {}),
    listings: Object.values(seen).map(function (l) { return Object.assign(l, { mcQ: Object.keys(tags[l.vin] || {}) }); }), errors: errors, notices: notices,
    fingerprints: fingerprints, unchanged: unchanged, rateLimited: rateLimited, rateLimitInfo: rateLimitInfo, quota: quota,
    keysUsed: keysUsed, keyQuotas: Object.keys(snaps).map(function (i) { return snaps[i]; }), calls: meter.calls,
    queries: queries, splits: splits, national: national,
    // Profiles still needing per-location searches (only reported for national "only").
    localProfiles: opts.national === "only" ? localList.map(function (p) { return p.id; }) : [],
  };
}

// ── MarketCheck query construction ──
// One VIN, any car_type (a VIN may be listed under more than one).
export function buildVinUrl(apiKey, vin) {
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  q.set("vin", vin);
  q.set("rows", "10");
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
export function buildUrl(apiKey, profile, hub, start, carType, dealerType) {
  const p = profile.params || {};
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  // car_type=used includes certified pre-owned (see CAR_TYPES).
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
  // Most recently (re)crawled first. Any change to a result set then shows on
  // page 1 — a re-priced or new car jumps to the top, a removed one lowers
  // num_found — which is what lets an unchanged search stop after one page.
  q.set("sort_by", "last_seen");
  q.set("sort_order", "desc");
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
    // powertrain on the card; fall back to the plain trim.
    trim: build.version || build.trim || "",
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
  const hubName = hub.n || hub.z || "Boston MA"; // a hub may carry only a ZIP
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
