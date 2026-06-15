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

const HOST = process.env.MARKETCHECK_HOST || "https://mc-api.marketcheck.com";
const ENDPOINT = "/v2/search/car/active";
// Free tier caps radius at 100mi; override with MARKETCHECK_RADIUS on a paid
// plan. A hub may also carry its own `r` to override per-location.
const RADIUS_MI = Number(process.env.MARKETCHECK_RADIUS) || 100;
const ROWS = 50; // page size; one page is plenty for a tight watchlist

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
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      debug.status = r.status;
      const json = await r.json().catch(function () { return null; });
      debug.topLevelKeys = json ? Object.keys(json) : [];
      debug.num_found = json && json.num_found != null ? json.num_found : undefined;
      const rows = json && Array.isArray(json.listings) ? json.listings : [];
      debug.rawSample = rows.slice(0, 2);
      debug.normalizedSample = rows.slice(0, 2).map(function (row) { return normalize(row, pr.id); });
    } catch (e) {
      debug.error = e && e.message ? e.message : "fetch failed";
    }
    res.status(200).json(debug);
    return;
  }

  const seen = {}; // vin -> normalized listing (dedup across hubs, keep lowest price)
  const errors = [];

  for (const pr of profiles) {
    for (const hub of hubs) {
      const label = (pr.name || pr.id || "?") + " @ " + (hub.n || hub.z || "?");
      try {
        const r = await fetch(buildUrl(apiKey, pr, hub), { headers: { Accept: "application/json" } });
        if (!r.ok) {
          errors.push(label + ": MarketCheck HTTP " + r.status);
          continue;
        }
        const json = await r.json();
        const rows = Array.isArray(json.listings) ? json.listings : [];
        for (const row of rows) {
          const norm = normalize(row, pr.id);
          if (!norm || !norm.vin) continue;
          const prev = seen[norm.vin];
          if (!prev || (norm.price && norm.price < prev.price)) seen[norm.vin] = norm;
        }
      } catch (e) {
        errors.push(label + ": " + (e && e.message ? e.message : "fetch failed"));
      }
    }
  }

  res.status(200).json({ listings: Object.values(seen), errors });
}

// ── MarketCheck query construction ──
function buildUrl(apiKey, profile, hub) {
  const p = profile.params || {};
  const q = new URLSearchParams();
  q.set("api_key", apiKey);
  q.set("car_type", "used");
  q.set("seller_type", "dealer");
  if (p.make) q.set("make", p.make);
  if (p.model) q.set("model", p.model);
  const years = parseYears(p.years);
  if (years) q.set("year", years);
  if (p.maxPrice) q.set("price_range", "0-" + Math.round(p.maxPrice));
  if (p.maxMiles) q.set("miles_range", "0-" + Math.round(p.maxMiles));
  if (hub.z) q.set("zip", hub.z);
  q.set("radius", String(hub.r || RADIUS_MI));
  q.set("rows", String(ROWS));
  q.set("start", "0");
  return HOST + ENDPOINT + "?" + q.toString();
}

// "2019-2022" -> "2019,2020,2021,2022"; "2016, 2018" -> "2016,2018"
function parseYears(s) {
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

// ── MarketCheck listing -> app listing shape ──
function normalize(row, profileId) {
  if (!row || typeof row !== "object") return null;
  const build = row.build || {};
  const dealer = row.dealer || {};
  const vehicle = ((build.make || "") + " " + (build.model || "")).trim();
  return {
    vin: row.vin || "",
    vehicle: vehicle,
    year: Number(build.year) || 0,
    trim: build.trim || "",
    price: Number(row.price) || 0,
    mileage: Number(row.miles) || 0,
    dealer: dealer.name || "",
    dealerType: mapDealerType(row, dealer),
    location: dealer.city || "",
    state: dealer.state || "",
    color: row.exterior_color || "",
    link: row.vdp_url || "",
    dom: row.dom != null ? Number(row.dom) : null,
    profileId: profileId,
    source: "marketcheck",
  };
}

function mapDealerType(row, dealer) {
  if (row.cpo === true || row.cpo === "True" || row.cpo === "true") return "CPO";
  const dt = String(dealer.dealer_type || row.seller_type || "").toLowerCase();
  if (dt.indexOf("independ") > -1) return "independent";
  if (dt.indexOf("private") > -1) return "private";
  return "franchise";
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// ── Mock data (?mock=1): two synthetic listings per active profile ──
function mockListings(profiles, hubs) {
  const hub = (hubs && hubs[0]) || { n: "Boston MA", z: "02101" };
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
        dealerType: k === 0 ? "CPO" : "franchise",
        location: hub.n.split(" ")[0],
        state: hub.n.slice(-2),
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
