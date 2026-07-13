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
// Regular used + certified pre-owned are separate MarketCheck car_types (a
// car_type=used query does NOT include CPO), so we query both to catch CPO cars.
const CAR_TYPES = ["used", "certified"];
// Free tier rate-limits bursts; space sequential queries out and retry 429s.
const THROTTLE_MS = Number(process.env.MARKETCHECK_THROTTLE_MS) || 500;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch that retries on HTTP 429 with backoff (honoring Retry-After).
async function fetchWithRetry(url, opts) {
  let attempt = 0;
  while (true) {
    const r = await fetch(url, opts);
    if (r.status !== 429 || attempt >= MAX_RETRIES) return r;
    const ra = parseFloat(r.headers.get("retry-after") || "");
    const waitMs = ra > 0 ? Math.min(ra * 1000, 5000) : Math.min(500 * Math.pow(2, attempt), 4000);
    await sleep(waitMs);
    attempt++;
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

  const apiKey = process.env.MARKETCHECK_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "MARKETCHECK_API_KEY is not configured on the server" });
    return;
  }

  // Debug: run one real query (first profile × first hub) and return the raw
  // MarketCheck response alongside how normalize() maps it — for confirming the
  // live field names. Key redacted from the echoed URL.
  if (raw) {
    const pr = profiles[0];
    const hub = hubs[0];
    if (!pr || !hub) {
      res.status(400).json({ error: "raw mode needs at least one profile and one hub" });
      return;
    }
    const url = buildUrl(apiKey, pr, hub);
    const debug = { request: url.replace(/(api_key=)[^&]*/, "$1REDACTED"), profile: pr.id, hub: hub };
    try {
      const r = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
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
          const u = new URL(url);
          v.drop.forEach(function (k) { u.searchParams.delete(k); });
          try {
            const rr = await fetchWithRetry(u.toString(), { headers: { Accept: "application/json" } });
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

  const r = await searchListings(apiKey, profiles, hubs, { dealerType: dealerType });
  res.status(200).json({ listings: r.listings, errors: r.errors });
}

// Core active-inventory search for a set of profiles × hubs — shared by the
// HTTP handler above and the scheduled background sync (api/cron-sync.js).
// opts: { dealerType, budgetMs }. Returns { listings: [<normalized>], errors }.
export async function searchListings(apiKey, profiles, hubs, opts) {
  opts = opts || {};
  const dealerType = opts.dealerType || null;
  const seen = {}; // vin -> normalized listing (dedup across hubs, keep lowest price)
  const errors = [];

  // Stop issuing new queries before the function wall so we return partial
  // results instead of a 504. The client already splits by hub, so this is a
  // backstop for a single dense hub (nationwide radius × many profiles/pages).
  const deadline = Date.now() + (Number(opts.budgetMs) || Number(process.env.MARKETCHECK_BUDGET_MS) || 50000);
  let timeUp = false;

  let first = true;
  for (const pr of profiles) {
    if (timeUp) break;
    for (const hub of hubs) {
      if (timeUp) break;
      for (const carType of CAR_TYPES) {
        if (timeUp) break;
        const label = (pr.name || pr.id || "?") + " @ " + (hub.n || hub.z || "?") + " [" + carType + "]";
        // Page through results (bounded by MAX_ROWS) so a dense query doesn't
        // truncate at 50 and drop still-active listings.
        for (let start = 0; start < MAX_ROWS; start += ROWS) {
          if (Date.now() > deadline) {
            errors.push("Stopped early to avoid a timeout — some results may be missing. Use fewer locations, a smaller radius, or narrower filters.");
            timeUp = true;
            break;
          }
          if (!first) await sleep(THROTTLE_MS); // stay under the burst rate limit
          first = false;
          let numFound = null;
          try {
            const url = buildUrl(apiKey, pr, hub, start, carType, dealerType);
            const r = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
            if (!r.ok) {
              // Auto-debug: 4xx bodies name the offending param. Echo it (+ the
              // sent query, key redacted) so the error itself is actionable.
              let body = "";
              try { body = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
              const sent = url.split("?")[1] ? url.split("?")[1].replace(/api_key=[^&]*&?/, "") : "";
              errors.push(label + ": MarketCheck HTTP " + r.status + (body ? " — " + body : "") + (r.status >= 400 && r.status < 500 ? " [sent: " + sent + "]" : ""));
              break; // stop paging this profile×hub on error
            }
            const json = await r.json();
            numFound = typeof json.num_found === "number" ? json.num_found : null;
            const rows = Array.isArray(json.listings) ? json.listings : [];
            for (const row of rows) {
              const norm = normalize(row, pr.id);
              if (!norm || !norm.vin) continue;
              // Backstop the dealer_type filter in case the API returns extras.
              if (dealerType === "franchise" && norm.dealerType !== "franchise") continue;
              const prev = seen[norm.vin];
              // Lowest REAL price wins — a priced row always beats an unpriced one.
              if (!prev || (norm.price && (!prev.price || norm.price < prev.price))) seen[norm.vin] = norm;
            }
            // Last page: fewer than a full page back, or we've covered num_found.
            if (rows.length < ROWS || (numFound != null && start + ROWS >= numFound)) break;
          } catch (e) {
            errors.push(label + ": " + (e && e.message ? e.message : "fetch failed"));
            break;
          }
        }
      }
    }
  }

  return { listings: Object.values(seen), errors: errors };
}

// ── MarketCheck query construction ──
export function buildUrl(apiKey, profile, hub, start, carType, dealerType) {
  const p = profile.params || {};
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  // "used" and "certified" are distinct car_types (used excludes CPO), so the
  // sync runs both to cover regular + certified inventory.
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
  if (hub.lat != null && hub.lon != null) {
    q.set("latitude", String(hub.lat));
    q.set("longitude", String(hub.lon));
  } else if (hub.z) {
    q.set("zip", hub.z);
  }
  q.set("radius", String(hub.r || RADIUS_MI));
  q.set("rows", String(ROWS));
  q.set("start", String(start || 0));
  return HOST + ENDPOINT + "?" + q.toString();
}

// Map friendly powertrain words to MarketCheck's powertrain_type codes
// (HEV/PHEV/Combustion). Pass through already-correct codes and unknowns.
export function mapPowertrain(v) {
  const k = String(v || "").trim().toLowerCase();
  if (k === "hybrid" || k === "hev") return "HEV";
  if (k === "phev" || k === "plug-in hybrid" || k === "plugin hybrid" || k === "plug in hybrid") return "PHEV";
  if (k === "gas" || k === "gasoline" || k === "combustion") return "Combustion";
  return v;
}

// "2019-2022" -> "2019,2020,2021,2022"; "2016, 2018" -> "2016,2018"
export function parseYears(s) {
  if (!s) return "";
  const out = [];
  String(s).split(",").forEach(function (part) {
    const t = part.trim();
    const range = t.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (range) {
      let a = +range[1], b = +range[2];
      if (a > b) { const tmp = a; a = b; b = tmp; }
      for (let y = a; y <= b; y++) out.push(y);
    } else if (/^\d{4}$/.test(t)) {
      out.push(+t);
    }
  });
  return Array.from(new Set(out)).sort().join(",");
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
  return {
    vin: row.vin || "",
    vehicle: vehicle,
    year: Number(build.year) || 0,
    // version is the fuller variant (e.g. "Hybrid LE AWD") — surfaces the
    // powertrain on the card; fall back to the plain trim.
    trim: build.version || build.trim || "",
    price: Number(row.price) || 0,
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
    dom: row.dom != null ? Number(row.dom) : null,
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
// only present on certified cars). NOTE: car_type=used does NOT return certified
// vehicles — they're a distinct car_type=certified category — so the sync queries
// both (see CAR_TYPES) and this labels which came back certified.
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
