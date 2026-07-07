import { useState, useEffect, useCallback, useRef } from "react";
import storage from "./storage";
import { signOut } from "./Auth";
import { fetchListings, fetchRawSample, reconcile } from "./sync";
import { getKeyStatus, saveKey, removeKey, scoreSet, getScorePrompt, generateBaseline, SCORE_MODEL_OPTIONS, DEFAULT_SCORE_MODEL } from "./score";
import { getMe, listAllowed, addAllowed, removeAllowed } from "./admin";

var AUTO_SYNC_HOURS = 12; // sync-on-open debounce
var AUTO_SCORE_MAX = 20; // skip auto-score above this many items (avoid burning credits)

var STORAGE_KEY = "car-search-data";
var VERSION = 6;
var STALE_DAYS = 5;
var BUDGET = 40000; // default budget; per-user override in data.settings.budget
var TAX = 0.07;
var SALT = new Set("CT,MA,NH,VT,ME,NY,NJ,PA,OH,MI,WI,MN,IL,IN,IA,MD,DE,WV,RI".split(","));

// Starter global requirements (fed to AI scoring). Broad rules first; the
// color/taste preferences (gold, then the soft prefer-not-black) come last.
// Salt-belt rust is handled by the "location & salt exposure" scoring criterion.
var DEFAULT_REQS = [
  { id: "clean-title", text: "Clean title (no salvage, rebuilt, or branded)", active: true },
  { id: "no-accidents", text: "No accident history", active: true },
  { id: "no-mech", text: "No significant mechanical issues", active: true },
  { id: "no-gold", text: "No gold exterior color", active: true },
  { id: "no-black-pref", text: "Prefer not black exterior (soft preference)", active: true },
];

var DEFAULT_PROFILES = [
  { id: "rav4-hybrid", name: "RAV4 Hybrid", role: "SUV", active: true,
    params: { make: "Toyota", model: "RAV4", powertrain: "Hybrid", years: "2019-2022", trims: "XLE, XSE", maxPrice: 25000, maxMiles: 90000,
      mustHave: "AWD, hybrid", niceToHave: "Weather Pkg, CPO, wireless CarPlay (2022)", dealbreakers: "" } },
  { id: "rav4-prime", name: "RAV4 Prime", role: "SUV", active: true,
    params: { make: "Toyota", model: "RAV4", powertrain: "PHEV", years: "2021-2022", trims: "SE, XSE", maxPrice: 28000, maxMiles: 90000,
      mustHave: "AWD, PHEV", niceToHave: "Premium pkg, Weather pkg, CPO", dealbreakers: "" } },
  { id: "bolt-euv", name: "Bolt EUV", role: "Commuter", active: true,
    params: { make: "Chevrolet", model: "Bolt EUV", years: "2022-2023", trims: "LT, Premier", maxPrice: 19000, maxMiles: 70000,
      mustHave: "Post-recall battery replacement documented", niceToHave: "Sun & Sound pkg, Super Cruise", dealbreakers: "No battery recall docs" } },
  { id: "bolt-ev", name: "Bolt EV", role: "Commuter", active: true,
    params: { make: "Chevrolet", model: "Bolt EV", years: "2021-2023", trims: "LT, Premier", maxPrice: 16000, maxMiles: 70000,
      mustHave: "Post-recall battery replacement documented", niceToHave: "DC fast charge, Driver Confidence II", dealbreakers: "No battery recall docs" } },
  { id: "volt", name: "Volt", role: "Commuter", active: true,
    params: { make: "Chevrolet", model: "Volt", years: "2016, 2018", trims: "LT w/ DC-II, Premier", maxPrice: 14000, maxMiles: 90000,
      mustHave: "Gen 2 (2016+), BECM extended warranty", niceToHave: "Heated seats, adaptive cruise", dealbreakers: "2017 or 2019 model year" } },
  { id: "outback", name: "Outback", role: "SUV", active: true,
    params: { make: "Subaru", model: "Outback", years: "2020-2022", trims: "Premium, Limited, Base", trimInclude: "", trimExclude: "XT, Turbo, Onyx, Wilderness", maxPrice: 25000, maxMiles: 100000,
      mustHave: "AWD (standard); non-turbo 2.5L; rear-passenger safety (IIHS Acceptable rear)", niceToHave: "Premium or Limited trim, moonroof, heated seats, power driver seat", dealbreakers: "Turbo XT / Onyx Edition XT / Wilderness (reliability); open CVT recall WRK-22 or brake-bolt recall WUL-97" } },
];

var DEFAULT_CRITERIA = [
  { id: "price", name: "Price vs. budget", weight: 25 },
  { id: "mileage", name: "Mileage vs. age", weight: 15 },
  { id: "dealer", name: "Dealer type", weight: 10 },
  { id: "condition", name: "Condition / history", weight: 15 },
  { id: "features", name: "Trim & features", weight: 10 },
  { id: "color", name: "Color", weight: 5 },
  { id: "location", name: "Location & salt exposure", weight: 10 },
  { id: "deal", name: "Deal rating", weight: 10 },
];

var HUBS = [
  { n: "Boston MA", z: "02101", lat: 42.3601, lon: -71.0589 },
  { n: "Durham NC", z: "27701", lat: 35.994, lon: -78.8986 },
];

// Per-user settings (synced in data.settings). Defaults preserve the original
// two-car/Northeast setup; the setup wizard and the Settings card edit them.
// There's no single/multi-car "mode" — one-car shopping is just the case where
// only one car type (role) is active, and the pairing widgets follow from that.
var DEFAULT_SETTINGS = {
  budget: BUDGET,
  taxRate: TAX,
  tagline: "2-car · Boston + Durham · ≤$40K",
  hubs: HUBS,
};
function getSettings(data) { return Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {}); }

// ── Utility ──
// Pre-tax budget left after buying a car at pre-tax price p.
function calcRem(p, budget, tax) {
  if (budget == null) budget = BUDGET;
  if (tax == null) tax = TAX;
  return Math.round((budget - p * (1 + tax)) / (1 + tax));
}

// Stable-ish color for a freeform role label (SUV/Commuter keep their originals).
var ROLE_PALETTE = ["#1a5c3a", "#1a3c5c", "#5c1a3c", "#3c5c1a", "#5c3c1a", "#3c1a5c", "#1a5c5c"];
function roleColor(role) {
  if (!role) return "#444";
  if (role === "SUV") return "#1a5c3a";
  if (role === "Commuter") return "#1a3c5c";
  var h = 0;
  for (var i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) >>> 0;
  return ROLE_PALETTE[h % ROLE_PALETTE.length];
}
// Distinct role labels among active profiles (drives dynamic grouping/filtering).
function activeRoles(data) {
  var seen = [];
  (data.profiles || []).forEach(function (p) {
    if (p.active && p.role && seen.indexOf(p.role) === -1) seen.push(p.role);
  });
  return seen;
}
// Role chip; renders nothing for an empty/unknown role (single-car setups).
function RoleBadge({ role, extra }) {
  if (!role || role === "?") return null;
  return (<span style={Object.assign({}, S.role, { background: roleColor(role) }, extra || {})}>{role}</span>);
}
function isSalt(st) { return SALT.has((st || "").toUpperCase()); }
function daysSince(d) { if (!d) return Infinity; return Math.floor((new Date() - new Date(d)) / 864e5); }
function today() { return new Date().toISOString().split("T")[0]; }
function calcScore(scores, crit) {
  var tw = 0, w = 0;
  for (var i = 0; i < crit.length; i++) {
    var s = scores && scores[crit[i].id];
    if (s != null && s > 0) { w += s * crit[i].weight; tw += crit[i].weight; }
  }
  return tw > 0 ? +(w / tw).toFixed(1) : 0;
}
function recalcAll(list, crit) {
  return (list || []).map(function (l) {
    return Object.assign({}, l, { compositeScore: calcScore(l.scores, crit) });
  });
}
// Merge an AI scoring result onto a listing/candidate: per-criterion scores feed
// the existing weighted composite, plus the dedicated AI summary + rationales.
function applyScore(obj, r, crit, hash) {
  var scores = Object.assign({}, obj.scores || {}, r.scores || {});
  return Object.assign({}, obj, {
    scores: scores,
    aiSummary: r.summary || obj.aiSummary || "",
    aiRationales: r.rationales || obj.aiRationales || {},
    scoredAt: new Date().toISOString(),
    scoreHash: hash != null ? hash : obj.scoreHash, // fingerprint of the inputs this score was produced under
    compositeScore: calcScore(scores, crit),
  });
}

// A stable, non-cryptographic 64-bit-ish string hash (twin FNV-1a) -> base36.
// Collisions are astronomically unlikely at our scale, and the worst case of one
// is a missed "re-score" nudge — so cheap + synchronous beats crypto.subtle here.
function hashStr(s) {
  var h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

// Fingerprint of everything that determines a listing's AI score for a given
// profile: model, system prompt, criteria (id/name/weight/guidance), active
// global requirements, and the profile facts + price baseline fed to the model
// (mirrors api/_scoring.js buildUserPrompt). Listing-specific facts (price,
// mileage) are intentionally excluded — those are tracked separately via
// reviewPending. Stamped onto each item at score time so we can flag a score as
// stale once the user edits how scoring works.
function scoreInputHash(data, profile) {
  var parts = [data.scoreModel || DEFAULT_SCORE_MODEL, data.scorePrompt || ""];
  (data.criteria || []).forEach(function (c) {
    parts.push("crit|" + c.id + "|" + (c.name || "") + "|" + (c.weight || 0) + "|" + (c.guidance || ""));
  });
  (data.globalReqs || []).filter(function (r) { return r.active; }).forEach(function (r) { parts.push("req|" + (r.text || "")); });
  var p = (profile && profile.params) || {};
  parts.push("prof|" + (profile ? profile.name || "" : ""));
  ["make", "model", "powertrain", "years", "trims", "maxPrice", "maxMiles", "mustHave", "niceToHave", "dealbreakers"].forEach(function (k) {
    parts.push(k + "|" + (p[k] == null ? "" : p[k]));
  });
  if (p.priceBaseline) parts.push("bl|" + JSON.stringify(p.priceBaseline));
  return hashStr(parts.join("|"));
}

// A scored item is "stale" when the inputs changed since it was scored. Items
// scored before this fingerprint existed carry no scoreHash — treated as
// not-stale (no nagging) until their next score stamps one.
function scoreIsStale(item, sig) {
  return !!(item && item.scoredAt && item.scoreHash && sig && item.scoreHash !== sig);
}

// ── Import Validation ──
var REQUIRED_FIELDS = ["vehicle", "year", "price", "profileId"];
var VALID_STATUSES = ["watch", "rejected", "purchased"];
var VALID_DEALER_TYPES = ["CPO", "franchise", "independent", "private"];

function validateListing(obj, index, profileIds) {
  var errors = [];
  var prefix = "Listing " + (index + 1) + ": ";
  if (typeof obj !== "object" || obj === null) return [prefix + "not an object"];
  REQUIRED_FIELDS.forEach(function (f) {
    if (!obj[f] && obj[f] !== 0) errors.push(prefix + "missing required field '" + f + "'");
  });
  if (obj.profileId && profileIds.indexOf(obj.profileId) === -1) {
    errors.push(prefix + "unknown profileId '" + obj.profileId + "' — valid IDs: " + profileIds.join(", "));
  }
  if (obj.year && (isNaN(Number(obj.year)) || Number(obj.year) < 2010 || Number(obj.year) > 2026)) {
    errors.push(prefix + "year " + obj.year + " looks wrong (expected 2010-2026)");
  }
  if (obj.price && (isNaN(Number(obj.price)) || Number(obj.price) <= 0)) {
    errors.push(prefix + "price must be a positive number");
  }
  if (obj.mileage && isNaN(Number(obj.mileage))) {
    errors.push(prefix + "mileage must be a number");
  }
  if (obj.status && VALID_STATUSES.indexOf(obj.status) === -1) {
    errors.push(prefix + "invalid status '" + obj.status + "' — use: " + VALID_STATUSES.join(", "));
  }
  if (obj.dealerType && VALID_DEALER_TYPES.indexOf(obj.dealerType) === -1) {
    errors.push(prefix + "invalid dealerType '" + obj.dealerType + "' — use: " + VALID_DEALER_TYPES.join(", "));
  }
  if (obj.scores && typeof obj.scores === "object") {
    Object.keys(obj.scores).forEach(function (k) {
      var v = obj.scores[k];
      if (typeof v !== "number" || v < 1 || v > 10) errors.push(prefix + "score '" + k + "' must be 1-10, got " + v);
    });
  }
  return errors;
}

function parseImport(text, profileIds) {
  var result = { listings: [], errors: [], warnings: [] };
  var parsed;
  try {
    var trimmed = text.trim();
    if (trimmed.charAt(0) === "[") {
      parsed = JSON.parse(trimmed);
    } else if (trimmed.charAt(0) === "{") {
      parsed = [JSON.parse(trimmed)];
    } else {
      result.errors.push("Input must be JSON: an array [...] or single object {...}");
      return result;
    }
  } catch (e) {
    result.errors.push("Invalid JSON: " + e.message);
    return result;
  }
  if (!Array.isArray(parsed)) {
    result.errors.push("Expected an array of listings");
    return result;
  }
  if (parsed.length === 0) {
    result.errors.push("Array is empty — no listings to import");
    return result;
  }
  if (parsed.length > 50) {
    result.warnings.push("Large import (" + parsed.length + " listings). Processing first 50.");
    parsed = parsed.slice(0, 50);
  }
  parsed.forEach(function (obj, i) {
    var errs = validateListing(obj, i, profileIds);
    if (errs.length > 0) {
      result.errors = result.errors.concat(errs);
    } else {
      var clean = {
        vehicle: String(obj.vehicle || ""),
        year: Number(obj.year),
        trim: String(obj.trim || ""),
        price: Number(obj.price),
        mileage: Number(obj.mileage || 0),
        profileId: String(obj.profileId),
        dealer: String(obj.dealer || ""),
        dealerType: VALID_DEALER_TYPES.indexOf(obj.dealerType) > -1 ? obj.dealerType : "franchise",
        location: String(obj.location || ""),
        state: String(obj.state || ""),
        color: String(obj.color || ""),
        vin: String(obj.vin || ""),
        link: String(obj.link || ""),
        dealRating: String(obj.dealRating || ""),
        notes: String(obj.notes || ""),
        status: VALID_STATUSES.indexOf(obj.status) > -1 ? obj.status : "watch",
        scores: obj.scores && typeof obj.scores === "object" ? obj.scores : {},
        rejectReason: String(obj.rejectReason || ""),
      };
      result.listings.push(clean);
    }
  });
  if (result.listings.length > 0 && result.errors.length > 0) {
    result.warnings.push(result.listings.length + " valid, " + result.errors.length + " error(s) — only valid listings shown for review.");
  }
  return result;
}

// ── Profile import (paste JSON array of profiles) ──
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function parseProfiles(text) {
  var out = { profiles: [], errors: [] };
  var parsed;
  try { parsed = JSON.parse(String(text).trim()); } catch (e) { out.errors.push("Invalid JSON: " + e.message); return out; }
  if (!Array.isArray(parsed)) { if (parsed && typeof parsed === "object") parsed = [parsed]; else { out.errors.push("Expected an array of profiles"); return out; } }
  parsed.forEach(function (p, i) {
    if (!p || typeof p !== "object") { out.errors.push("Profile " + (i + 1) + ": not an object"); return; }
    var params = p.params || p;
    var make = String(params.make || "").trim();
    var model = String(params.model || "").trim();
    if (!make || !model) { out.errors.push("Profile " + (i + 1) + ": needs make and model"); return; }
    out.profiles.push({
      id: String(p.id || slug(make + "-" + model + "-" + (params.powertrain || "")) || ("p-" + i)),
      name: String(p.name || (make + " " + model)).trim(),
      role: String(p.role || ""),
      active: p.active !== false,
      params: {
        make: make, model: model,
        powertrain: String(params.powertrain || ""),
        years: String(params.years || ""),
        trims: String(params.trims || ""),
        trimInclude: String(params.trimInclude || ""),
        trimExclude: String(params.trimExclude || ""),
        maxPrice: Number(params.maxPrice) || 0,
        maxMiles: Number(params.maxMiles) || 0,
        mustHave: String(params.mustHave || ""),
        niceToHave: String(params.niceToHave || ""),
        dealbreakers: String(params.dealbreakers || ""),
        priceBaseline: (params.priceBaseline && typeof params.priceBaseline === "object") ? params.priceBaseline : undefined,
      },
    });
  });
  return out;
}

// Fuzzy (case-insensitive substring) trim filter. `trimText` is matched against
// comma-separated include/exclude terms: excluded if it contains any exclude
// term; if any include terms are set, kept only if it contains one of them.
function trimAllowed(trimText, includeStr, excludeStr) {
  var t = String(trimText || "").toLowerCase();
  var terms = function (s) { return String(s || "").split(",").map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean); };
  var exc = terms(excludeStr);
  if (exc.some(function (e) { return t.indexOf(e) > -1; })) return false;
  var inc = terms(includeStr);
  if (inc.length && !inc.some(function (e) { return t.indexOf(e) > -1; })) return false;
  return true;
}

// ── Dedup: VIN match keeps lower price ──
function dedupInsert(existing, newL) {
  if (!newL.vin) return existing.concat(newL);
  var idx = existing.findIndex(function (l) { return l.vin && l.vin === newL.vin; });
  if (idx === -1) return existing.concat(newL);
  if (newL.price < existing[idx].price) {
    var updated = existing.slice();
    updated[idx] = Object.assign({}, newL, {
      id: existing[idx].id, addedDate: existing[idx].addedDate,
      notes: ((newL.notes || "") + " [Dedup: was $" + existing[idx].price.toLocaleString() + " at " + existing[idx].dealer + "]").trim()
    });
    return updated;
  }
  return existing;
}

function migrate(data) {
  if (!data) return null;
  var v = data.version || 1;
  if (v < 2) {
    data.listings = (data.listings || []).map(function (l) {
      return Object.assign({}, l, { lastChecked: l.lastChecked || l.addedDate || today(), vin: l.vin || "" });
    });
  }
  if (v < 3) { data.globalReqs = data.globalReqs || DEFAULT_REQS; }
  if (v < 5) {
    // MarketCheck's model is "RAV4"; hybrids/PHEVs are filtered by powertrain_type.
    data.profiles = (data.profiles || []).map(function (p) {
      if (!p.params) return p;
      if (p.params.model === "RAV4 Hybrid") return Object.assign({}, p, { params: Object.assign({}, p.params, { model: "RAV4", powertrain: "Hybrid" }) });
      if (p.params.model === "RAV4 Prime") return Object.assign({}, p, { params: Object.assign({}, p.params, { model: "RAV4", powertrain: "PHEV" }) });
      return p;
    });
  }
  // v6: budget/tax/hubs/tagline moved into data.settings (was hardcoded).
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  // Existing users are already set up — don't pop the wizard at them.
  if (data.onboarded == null) data.onboarded = true;
  data.version = VERSION;
  return data;
}

// Pristine app state for a brand-new user or a reset. `blank` drops the
// owner's opinionated starter profiles/requirements (used by "start fresh").
function freshData(blank) {
  return {
    profiles: blank ? [] : DEFAULT_PROFILES,
    criteria: DEFAULT_CRITERIA,
    globalReqs: blank ? [] : DEFAULT_REQS,
    listings: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    onboarded: false,
    version: VERSION,
  };
}

// ── Tabs ──
var TABS = ["Dashboard", "Profiles", "Criteria", "Results", "Compare", "Help"];

// Session-scoped persistence for volatile UI state, so a mobile reload / tab
// discard on app-switch doesn't wipe in-progress results (candidates, raw
// output, current tab). Cleared when the tab is actually closed.
function ssGet(key, fallback) {
  try { var v = sessionStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
function ssSet(key, val) {
  try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* unavailable */ }
}

export default function App() {
  var [data, setData] = useState(null);
  var [loading, setLoading] = useState(true);
  var [tab, setTab] = useState(function () { return ssGet("cs-tab", "Dashboard"); });
  var [saving, setSaving] = useState(false);
  var [edListing, setEdListing] = useState(null);
  var [candidates, setCandidates] = useState(function () { return ssGet("cs-candidates", []); });
  var [importText, setImportText] = useState("");
  var [importResult, setImportResult] = useState(null);
  var [filterProf, setFilterProf] = useState("all");
  var init = useRef(false);

  var [exportJson, setExportJson] = useState("");
  var [rawDebug, setRawDebug] = useState(function () { return ssGet("cs-rawDebug", ""); });
  var [rawBusy, setRawBusy] = useState(false);
  var [syncing, setSyncing] = useState(false);
  var [syncMsg, setSyncMsg] = useState(null);

  // Persist the volatile bits so an app-switch reload restores them.
  useEffect(function () { ssSet("cs-tab", tab); }, [tab]);
  useEffect(function () { ssSet("cs-candidates", candidates); }, [candidates]);
  useEffect(function () { ssSet("cs-rawDebug", rawDebug); }, [rawDebug]);

  useEffect(function () {
    if (init.current) return;
    init.current = true;
    (async function () {
      try {
        var r = await storage.get(STORAGE_KEY);
        if (r && r.value && r.value !== "undefined") {
          var d = migrate(JSON.parse(r.value));
          d.listings = recalcAll(d.listings || [], d.criteria || DEFAULT_CRITERIA);
          setData(d);
          // Only write back if migration changed something
          if (d.version !== JSON.parse(r.value).version) {
            await storage.set(STORAGE_KEY, JSON.stringify(d));
          }
        } else {
          var d2 = freshData(false); // brand-new user: defaults + wizard (onboarded:false)
          setData(d2);
          await storage.set(STORAGE_KEY, JSON.stringify(d2));
        }
      } catch (e) {
        console.error("Init:", e);
        // DO NOT overwrite storage on error - just use defaults in memory
        setData(freshData(false));
      }
      setLoading(false);
    })();
  }, []);

  var save = useCallback(async function (nd) {
    setData(nd);
    setSaving(true);
    try { await storage.set(STORAGE_KEY, JSON.stringify(nd)); } catch (e) { console.error(e); }
    setSaving(false);
  }, []);

  var saveRecalc = useCallback(async function (nd) {
    nd.listings = recalcAll(nd.listings, nd.criteria);
    await save(nd);
  }, [save]);

  // Patch listings against the LATEST state (avoids clobbering concurrent sync
  // writes) and persist. Used by AI scoring, which may resolve after a sync.
  var patchListings = useCallback(function (updater) {
    setData(function (prev) {
      if (!prev) return prev;
      var nd = Object.assign({}, prev, { listings: updater(prev.listings || []) });
      storage.set(STORAGE_KEY, JSON.stringify(nd)).catch(function (e) { console.error(e); });
      return nd;
    });
  }, []);

  // ── AI scoring ──
  var [keyStatus, setKeyStatus] = useState({ configured: false, valid: false, last4: "" });
  var [scoreBusy, setScoreBusy] = useState(false);
  var [scoringActive, setScoringActive] = useState([]); // the exact items being scored right now (for per-card "Scoring…")
  var [scoreMsg, setScoreMsg] = useState(null);
  var [isAdmin, setIsAdmin] = useState(false);

  useEffect(function () {
    var cancelled = false;
    getKeyStatus().then(function (s) { if (!cancelled) setKeyStatus(s); });
    getMe().then(function (m) { if (!cancelled && m && m.isAdmin) setIsAdmin(true); });
    return function () { cancelled = true; };
  }, []);

  var autoScore = data ? data.autoScore !== false : true;
  var setAutoScore = useCallback(function (v) {
    setData(function (prev) {
      if (!prev) return prev;
      var nd = Object.assign({}, prev, { autoScore: !!v });
      storage.set(STORAGE_KEY, JSON.stringify(nd)).catch(function (e) { console.error(e); });
      return nd;
    });
  }, []);

  // Fall back to the default if the saved model is unknown/retired (e.g. an old
  // Sonnet 4.6 selection) so the picker and requests stay valid.
  var scoreModel = (data && data.scoreModel && SCORE_MODEL_OPTIONS.some(function (o) { return o.id === data.scoreModel; })) ? data.scoreModel : DEFAULT_SCORE_MODEL;
  var setScoreModel = useCallback(function (m) {
    setData(function (prev) {
      if (!prev) return prev;
      var nd = Object.assign({}, prev, { scoreModel: m });
      storage.set(STORAGE_KEY, JSON.stringify(nd)).catch(function (e) { console.error(e); });
      return nd;
    });
  }, []);

  function scoreErr(e) {
    if (e && e.code === "no_key") {
      setKeyStatus(function (s) { return Object.assign({}, s, { configured: false, valid: false }); });
      setScoreMsg({ ok: false, text: "Add your Anthropic API key below to enable AI scoring." });
    } else if (e && (e.code === "key_rejected" || e.code === "key_unreadable")) {
      setKeyStatus(function (s) { return Object.assign({}, s, { valid: false }); });
      setScoreMsg({ ok: false, text: (e.message || "Your Anthropic key was rejected") + " — re-enter it below." });
    } else {
      setScoreMsg({ ok: false, text: (e && e.message) || "Scoring failed" });
    }
  }

  // Score any mix of candidates (no id) and saved listings (have id), applying
  // results to the right place. Single entry point for manual + auto scoring.
  var scoreItems = useCallback(async function (cands, savedItems) {
    if (!data || scoreBusy) return;
    var all = (cands || []).concat(savedItems || []);
    if (!all.length) return;
    var profileById = {};
    (data.profiles || []).forEach(function (p) { profileById[p.id] = p; });
    var ctx = { criteria: data.criteria, globalReqs: data.globalReqs || [], profileById: profileById, model: data.scoreModel || DEFAULT_SCORE_MODEL, system: data.scorePrompt || "" };
    setScoreBusy(true);
    setScoringActive(all.map(function (x) { return x.id || x.vin || null; }).filter(Boolean));
    setScoreMsg({ busy: true, text: "Scoring " + all.length + " listing" + (all.length > 1 ? "s" : "") + "…" });

    // Apply one chunk's results the moment it returns — successes persist even if
    // a later chunk fails or the tab is backgrounded. Match by ref then id/vin.
    var okCount = 0, failCount = 0, firstErr = "";
    function applyPairs(pairs) {
      var byRef = new Map(), byKey = {};
      pairs.forEach(function (p) {
        if (!p.result || !p.result.ok) { failCount++; if (!firstErr) firstErr = (p.result && p.result.error) || ""; return; }
        okCount++;
        byRef.set(p.item, p.result);
        var k = p.item.id || p.item.vin;
        if (k) byKey[k] = p.result;
      });
      if (!byRef.size) return;
      var pick = function (x) { var r = byRef.get(x); if (r) return r; var k = x.id || x.vin; return k ? byKey[k] : null; };
      setCandidates(function (prev) { return prev.map(function (c) { if (c.id) return c; var r = pick(c); return r ? applyScore(c, r, data.criteria, scoreInputHash(data, profileById[c.profileId])) : c; }); });
      patchListings(function (list) { return list.map(function (l) { var r = pick(l); return r ? applyScore(l, r, data.criteria, scoreInputHash(data, profileById[l.profileId])) : l; }); });
    }

    try {
      await scoreSet(all, ctx, {
        onProgress: function (d, t) { setScoreMsg({ busy: true, text: "Scoring " + d + "/" + t + "…" }); },
        onPairs: applyPairs,
      });
      setScoreMsg({ ok: failCount === 0, text: "Scored " + okCount + "/" + all.length + (failCount ? " (" + failCount + " failed" + (firstErr ? ": " + firstErr : "") + ")" : "") });
    } catch (e) {
      console.error("Score:", e);
      scoreErr(e); // key-level failure; any chunks that landed before it are already applied
    } finally {
      setScoreBusy(false);
      setScoringActive([]);
    }
  }, [data, scoreBusy, patchListings]);

  // Pull dealer inventory via the proxy and reconcile. New VINs flow into the
  // candidate queue (same review path as Import); known VINs get price/last-seen
  // updates written to the blob. opts.auto = background sync-on-open (quiet on error).
  var doSync = useCallback(async function (opts) {
    if (!data || syncing) return;
    var auto = opts && opts.auto;
    setSyncing(true);
    if (!auto) setSyncMsg(null);
    try {
      var active = data.profiles.filter(function (p) { return p.active; });
      if (!active.length) {
        if (!auto) setSyncMsg({ ok: false, error: "No active profiles to sync." });
        setSyncing(false);
        return;
      }
      var res = await fetchListings(active, getSettings(data).hubs, opts);
      var rec = reconcile(data.listings, res.listings, today());
      var decorated = rec.candidates.map(function (c) {
        return Object.assign({}, c, { compositeScore: calcScore(c.scores, data.criteria), _candidate: true });
      });
      // `added` = candidates genuinely NEW to the queue this run: drop VINs the
      // user skipped (live in data.skipped until restored) and VINs already in
      // the candidate queue from a prior sync (so we never auto-rescore them).
      var skippedVins = {};
      (data.skipped || []).forEach(function (s) { if (s.vin) skippedVins[s.vin] = true; });
      var queueVins = {};
      candidates.forEach(function (c) { if (c.vin) queueVins[c.vin] = true; });
      var added = decorated.filter(function (c) { return (!c.vin || !queueVins[c.vin]) && !(c.vin && skippedVins[c.vin]); });
      setCandidates(function (prev) {
        var seen = {};
        prev.forEach(function (c) { if (c.vin) seen[c.vin] = true; });
        return prev.concat(added.filter(function (c) { return !c.vin || !seen[c.vin]; }));
      });
      if (res.errors && res.errors.length) console.warn("Sync query errors:", res.errors);
      // Existing listings whose price changed this run — materially changed, so
      // eligible for an auto re-score (and flagged reviewPending by reconcile).
      var prevPrice = {};
      data.listings.forEach(function (l) { if (l.id) prevPrice[l.id] = l.price; });
      var changed = rec.listings.filter(function (l) { return l.id && prevPrice[l.id] != null && l.price !== prevPrice[l.id]; });
      await save(Object.assign({}, data, { listings: rec.listings, lastSynced: new Date().toISOString() }));
      // Report the count actually added to the queue (reconcile's newCount also
      // counts skipped VINs, which we hide), and note how many matched skips.
      var skippedSeen = decorated.filter(function (c) { return c.vin && skippedVins[c.vin]; }).length;
      setSyncMsg({ ok: true, summary: Object.assign({}, rec.summary, { newCount: added.length }), skippedSeen: skippedSeen, errors: res.errors, mock: res.mock });
      setSyncing(false);
      // Auto-score only NEW candidates (never skipped, never already-queued, not
      // already scored, and passing their profile's trim filter — no point
      // scoring a trim you've excluded) plus materially price-changed listings.
      // Best-effort; not awaited — sync is already done.
      if (autoScore && keyStatus.valid && !scoreBusy) {
        var profById = {};
        (data.profiles || []).forEach(function (p) { profById[p.id] = p; });
        // Every still-UNSCORED candidate in the queue (new this run + any left
        // over from a prior sync) that isn't trim-hidden — plus materially
        // changed listings. Already-scored candidates are left alone.
        var pool = candidates.concat(added);
        var newToScore = pool.filter(function (c) {
          if (c.scoredAt) return false;
          var p = profById[c.profileId];
          return !p || !p.params ? true : trimAllowed((c.trim || "") + " " + (c.vehicle || ""), p.params.trimInclude, p.params.trimExclude);
        });
        var toScoreCount = newToScore.length + changed.length;
        if (toScoreCount > AUTO_SCORE_MAX) {
          setScoreMsg({ ok: true, text: "Auto-score skipped — " + toScoreCount + " to score (over " + AUTO_SCORE_MAX + "). Use ✨ Score all or per-card to score selectively." });
        } else if (toScoreCount) {
          scoreItems(newToScore, changed);
        } else {
          setScoreMsg({ ok: true, text: "Auto-score: nothing new to score." });
        }
      } else if (autoScore && !keyStatus.valid) {
        setScoreMsg({ ok: false, text: "Auto-score is on but no valid Anthropic key — add one in the AI panel." });
      }
      return;
    } catch (e) {
      console.error("Sync:", e);
      if (!auto) setSyncMsg({ ok: false, error: e.message });
    }
    setSyncing(false);
  }, [data, syncing, save, autoScore, keyStatus, scoreBusy, scoreItems, candidates]);

  // Sync-on-open: once per load, if it's been a while since the last sync.
  var didAutoSync = useRef(false);
  useEffect(function () {
    if (loading || !data || didAutoSync.current) return;
    didAutoSync.current = true;
    var last = data.lastSynced ? new Date(data.lastSynced).getTime() : 0;
    if (Date.now() - last > AUTO_SYNC_HOURS * 3600 * 1000) doSync({ auto: true });
  }, [loading, data, doSync]);

  // Debug helper: run window.__rawSync() in the browser console (while signed
  // in) to see the raw MarketCheck response + how it normalizes — for
  // confirming live field names.
  useEffect(function () {
    if (typeof window === "undefined" || !data) return;
    window.__rawSync = function () {
      var active = data.profiles.filter(function (p) { return p.active; });
      return fetchRawSample(active, getSettings(data).hubs).then(function (r) { console.log("[rawSync]", r); return r; });
    };
  }, [data]);

  // Runs one live MarketCheck query and shows raw vs normalized output on-screen
  // (mobile-friendly equivalent of window.__rawSync()).
  var runRawDebug = useCallback(async function () {
    if (!data || rawBusy) return;
    setRawBusy(true); setRawDebug("");
    try {
      var active = data.profiles.filter(function (p) { return p.active; });
      var r = await fetchRawSample(active, getSettings(data).hubs);
      setRawDebug(JSON.stringify(r, null, 2));
    } catch (e) { setRawDebug("Error: " + (e && e.message ? e.message : String(e))); }
    setRawBusy(false);
  }, [data, rawBusy]);

  var viewProfile = useCallback(function (profileId) {
    setFilterProf(profileId);
    setTab("Results");
  }, [setTab]);

  var approveCand = useCallback(function (cand) {
    if (!data) return;
    var nl = Object.assign({}, cand, {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      addedDate: today(), lastChecked: today(), _candidate: undefined, _dupe: undefined, _existingPrice: undefined, _cheaper: undefined
    });
    var newList = dedupInsert(data.listings, nl);
    save(Object.assign({}, data, { listings: newList }));
    setCandidates(function (prev) { return prev.filter(function (c) { return c !== cand; }); });
  }, [data, save]);

  var approveAll = useCallback(function () {
    if (!data || !candidates.length) return;
    var profById = {};
    data.profiles.forEach(function (p) { profById[p.id] = p; });
    var newList = data.listings.slice();
    var approved = [];
    candidates.forEach(function (cand) {
      var p = profById[cand.profileId];
      var pass = !p || !p.params ? true : trimAllowed((cand.trim || "") + " " + (cand.vehicle || ""), p.params.trimInclude, p.params.trimExclude);
      if (!pass) return; // leave trim-hidden candidates in the queue
      var nl = Object.assign({}, cand, {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
        addedDate: today(), lastChecked: today(), _candidate: undefined, _dupe: undefined, _existingPrice: undefined, _cheaper: undefined
      });
      newList = dedupInsert(newList, nl);
      approved.push(cand);
    });
    save(Object.assign({}, data, { listings: newList }));
    setCandidates(function (prev) { return prev.filter(function (c) { return approved.indexOf(c) === -1; }); });
  }, [data, candidates, save]);

  // Skip → move into the persisted skipped list (so it survives reload/sync and
  // can be restored), strip transient flags.
  var dismissCand = useCallback(function (cand) {
    setCandidates(function (prev) { return prev.filter(function (c) { return c !== cand; }); });
    if (!data) return;
    var entry = Object.assign({}, cand, { _candidate: undefined, _dupe: undefined, _existingPrice: undefined, _cheaper: undefined, skippedAt: today() });
    save(Object.assign({}, data, { skipped: (data.skipped || []).concat([entry]) }));
  }, [data, save]);

  // Append a fuzzy trim term to a profile's include/exclude list (dedup).
  var addTrimTerm = useCallback(function (profileId, field, term) {
    term = String(term || "").trim();
    if (!term || !data) return;
    save(Object.assign({}, data, { profiles: data.profiles.map(function (p) {
      if (p.id !== profileId) return p;
      var terms = ((p.params && p.params[field]) || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (terms.map(function (s) { return s.toLowerCase(); }).indexOf(term.toLowerCase()) === -1) terms.push(term);
      return Object.assign({}, p, { params: Object.assign({}, p.params, { [field]: terms.join(", ") }) });
    }) }));
  }, [data, save]);

  // Exclude a shown candidate's trim (hides it + similar from candidates).
  var excludeTrim = useCallback(function (cand) { addTrimTerm(cand.profileId, "trimExclude", cand.trim); }, [addTrimTerm]);

  // "Show" a trim-hidden candidate: drop the exclude term(s) that caught it, or
  // (if it failed an include allowlist) add its trim to the include list.
  var showTrim = useCallback(function (cand) {
    if (!data) return;
    var p = (data.profiles || []).find(function (x) { return x.id === cand.profileId; });
    if (!p || !p.params) return;
    var t = ((cand.trim || "") + " " + (cand.vehicle || "")).toLowerCase();
    var exc = (p.params.trimExclude || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var matched = exc.filter(function (e) { return t.indexOf(e.toLowerCase()) > -1; });
    if (matched.length) {
      var kept = exc.filter(function (e) { return t.indexOf(e.toLowerCase()) === -1; });
      save(Object.assign({}, data, { profiles: data.profiles.map(function (x) { return x.id === p.id ? Object.assign({}, x, { params: Object.assign({}, x.params, { trimExclude: kept.join(", ") }) }) : x; }) }));
    } else {
      addTrimTerm(cand.profileId, "trimInclude", cand.trim);
    }
  }, [data, save, addTrimTerm]);

  // Skipped → back into the review queue.
  var restoreSkipped = useCallback(function (entry) {
    if (!data) return;
    setCandidates(function (prev) { return prev.concat([Object.assign({}, entry, { _candidate: true, skippedAt: undefined })]); });
    save(Object.assign({}, data, { skipped: (data.skipped || []).filter(function (s) { return s !== entry; }) }));
  }, [data, save]);

  // Skipped → straight onto the watchlist (same as approving a candidate).
  var watchSkipped = useCallback(function (entry) {
    if (!data) return;
    var nl = Object.assign({}, entry, {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      addedDate: today(), lastChecked: today(), status: "watch",
      _candidate: undefined, _dupe: undefined, _existingPrice: undefined, _cheaper: undefined, skippedAt: undefined,
    });
    save(Object.assign({}, data, {
      listings: dedupInsert(data.listings, nl),
      skipped: (data.skipped || []).filter(function (s) { return s !== entry; }),
    }));
  }, [data, save]);

  // Skipped → drop permanently (still won't resurface on sync since the VIN
  // would just re-enter as a fresh candidate; this only clears the record).
  var purgeSkipped = useCallback(function (entry) {
    if (!data) return;
    save(Object.assign({}, data, { skipped: (data.skipped || []).filter(function (s) { return s !== entry; }) }));
  }, [data, save]);

  var doImport = useCallback(function () {
    if (!data || !importText.trim()) return;
    var profileIds = data.profiles.map(function (p) { return p.id; });
    var result = parseImport(importText, profileIds);
    if (result.listings.length > 0) {
      var withScores = result.listings.map(function (l) {
        return Object.assign({}, l, { compositeScore: calcScore(l.scores, data.criteria), _candidate: true });
      });
      // Mark dupes
      withScores.forEach(function (v) {
        if (v.vin) {
          var existing = data.listings.find(function (el) { return el.vin && el.vin === v.vin; });
          if (existing) { v._dupe = true; v._existingPrice = existing.price; v._cheaper = v.price < existing.price; }
        }
      });
      setCandidates(withScores);
    }
    setImportResult(result);
  }, [data, importText]);

  var addListing = useCallback(function (l) {
    if (!data) return;
    var nl = Object.assign({}, l, {
      id: Date.now().toString(), addedDate: today(), lastChecked: today(), vin: l.vin || "",
      compositeScore: calcScore(l.scores, data.criteria)
    });
    save(Object.assign({}, data, { listings: dedupInsert(data.listings, nl) }));
  }, [data, save]);

  var updListing = useCallback(function (id, u) {
    if (!data) return;
    var nl = data.listings.map(function (l) {
      if (l.id !== id) return l;
      var m = Object.assign({}, l, u);
      m.compositeScore = calcScore(m.scores, data.criteria);
      return m;
    });
    save(Object.assign({}, data, { listings: nl }));
  }, [data, save]);

  var delListing = useCallback(function (id) {
    if (!data) return;
    save(Object.assign({}, data, { listings: data.listings.filter(function (l) { return l.id !== id; }) }));
  }, [data, save]);

  var markChk = useCallback(function (id) { updListing(id, { lastChecked: today() }); }, [updListing]);
  // Acknowledge a sync update: move it out of the review section back to the watchlist.
  var ackReview = useCallback(function (id) { updListing(id, { reviewPending: false }); }, [updListing]);
  var ackAllReviews = useCallback(function () {
    if (!data) return;
    save(Object.assign({}, data, { listings: data.listings.map(function (l) { return l.reviewPending ? Object.assign({}, l, { reviewPending: false }) : l; }) }));
  }, [data, save]);
  var markAllChk = useCallback(function () {
    if (!data) return;
    var t = today();
    save(Object.assign({}, data, { listings: data.listings.map(function (l) { return l.status === "watch" ? Object.assign({}, l, { lastChecked: t }) : l; }) }));
  }, [data, save]);

  var [confirmReset, setConfirmReset] = useState(false);
  var reset = useCallback(async function () {
    if (!confirmReset) { setConfirmReset(true); return; }
    await save(freshData(false)); // keep opinionated starters; re-runs the wizard
    setCandidates([]);
    setConfirmReset(false);
  }, [save, confirmReset]);

  if (loading) return (<div style={S.loading}>Loading...</div>);
  if (!data) return (<div style={S.loading}>Error loading data</div>);
  if (!data.onboarded) return (<Wizard data={data} onComplete={function (nd) { save(nd); }} />);

  var watch = data.listings.filter(function (l) { return l.status === "watch"; });
  var staleN = watch.filter(function (l) { return daysSince(l.lastChecked) >= STALE_DAYS; }).length;
  var rej = data.listings.filter(function (l) { return l.status === "rejected"; });
  var bought = data.listings.filter(function (l) { return l.status === "purchased"; });

  return (
    <div style={S.app}>
      <header style={S.header}>
        <div style={S.hRow}>
          <h1 style={S.title}>Car Search Tracker</h1>
          <span style={S.badge}>{saving ? "Saving..." : "Saved ✓"}</span>
        </div>
        <p style={S.sub}>{getSettings(data).tagline}</p>
        <nav style={S.nav}>
          {(isAdmin ? TABS.concat(["Admin"]) : TABS).map(function (t) {
            var label = t;
            if (t === "Results") {
              var n = data.listings.length + candidates.length;
              if (n) label = t + " (" + n + ")";
            }
            if (t === "Dashboard" && staleN) label = t + " ⏰";
            return (<button key={t} onClick={function () { setTab(t); }} style={Object.assign({}, S.tab, tab === t ? S.tabOn : {})}>{label}</button>);
          })}
        </nav>
      </header>

      <main>
        {tab === "Dashboard" && (
          <DashView data={data} watch={watch} rej={rej} bought={bought}
            staleN={staleN} setTab={setTab} markAllChk={markAllChk} viewProfile={viewProfile} />
        )}
        {tab === "Profiles" && <ProfilesTab data={data} save={save} keyOk={keyStatus.valid} scoreModel={scoreModel} />}
        {tab === "Criteria" && <CriteriaTab data={data} saveRecalc={saveRecalc} save={save} />}
        {tab === "Results" && (
          <ResultsTab data={data} addListing={addListing} updListing={updListing} delListing={delListing}
            edListing={edListing} setEdListing={setEdListing} markChk={markChk}
            ackReview={ackReview} ackAllReviews={ackAllReviews}
            candidates={candidates} approveCand={approveCand}
            approveAll={approveAll} dismissCand={dismissCand} excludeTrim={excludeTrim} showTrim={showTrim}
            skipped={data.skipped || []} restoreSkipped={restoreSkipped} watchSkipped={watchSkipped} purgeSkipped={purgeSkipped}
            importText={importText} setImportText={setImportText} doImport={doImport} importResult={importResult} setImportResult={setImportResult}
            filterProf={filterProf} setFilterProf={setFilterProf}
            doSync={doSync} syncing={syncing} syncMsg={syncMsg} lastSynced={data.lastSynced}
            keyStatus={keyStatus} setKeyStatus={setKeyStatus} autoScore={autoScore} setAutoScore={setAutoScore}
            scoreBusy={scoreBusy} scoreMsg={scoreMsg} scoreItems={scoreItems} scoringActive={scoringActive}
            scoreModel={scoreModel} setScoreModel={setScoreModel} />
        )}
        {tab === "Help" && <HelpTab />}
        {tab === "Compare" && <CompareTab data={data} />}
        {tab === "Admin" && isAdmin && <AdminTab />}
      </main>
      <footer style={S.footer}>
        <div style={{ display: "flex", justifyContent: "center", gap: 12, alignItems: "center" }}>
          <button onClick={function () {
            if (data) {
              var json = JSON.stringify(data.listings || [], null, 2);
              setExportJson(json);
              setTab("Results");
            }
          }} style={Object.assign({}, S.resetBtn, { color: "#6b9edd" })}>Export Listings</button>
          <button onClick={function () { runRawDebug(); }} disabled={rawBusy} style={Object.assign({}, S.resetBtn, { color: "#6b9edd" }, rawBusy ? { opacity: 0.6 } : {})}>{rawBusy ? "Running…" : "Debug raw"}</button>
          <button onClick={function () { save(Object.assign({}, data, { onboarded: false })); }} style={Object.assign({}, S.resetBtn, { color: "#6b9edd" })}>Setup wizard</button>
          <button onClick={reset} style={Object.assign({}, S.resetBtn, confirmReset ? { color: "#c44" } : {})}>
            {confirmReset ? "Tap again to confirm reset" : "Reset All Data"}
          </button>
          {confirmReset && <button onClick={function () { setConfirmReset(false); }} style={S.resetBtn}>Cancel</button>}
          <button onClick={function () { signOut(); }} style={S.resetBtn}>Sign out</button>
        </div>
        {exportJson && (
          <div style={{ marginTop: 8, padding: 10, background: "#161820", borderRadius: 6, border: "1px solid #1e2028", textAlign: "left", maxHeight: 150, overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "#6b6b76" }}>Listings JSON (copy this to back up)</span>
              <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { setExportJson(""); }}>Close</button>
            </div>
            <textarea readOnly value={exportJson} style={Object.assign({}, S.ta, { width: "100%", minHeight: 80, fontSize: 10, boxSizing: "border-box" })}
              onClick={function (e) { e.target.select(); }} />
          </div>
        )}
        {(rawBusy || rawDebug) && (
          <div style={{ marginTop: 8, padding: 10, background: "#161820", borderRadius: 6, border: "1px solid #1e2028", textAlign: "left", maxHeight: 260, overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "#6b6b76" }}>Raw debug — 1 live query (rawSample vs normalizedSample / error body)</span>
              {!rawBusy && <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { setRawDebug(""); }}>Close</button>}
            </div>
            <textarea readOnly value={rawBusy ? "Running one live query…" : rawDebug} style={Object.assign({}, S.ta, { width: "100%", minHeight: 140, fontSize: 10, boxSizing: "border-box" })}
              onClick={function (e) { e.target.select(); }} />
          </div>
        )}
      </footer>
    </div>
  );
}

// ── Dashboard ──
function DashView({ data, watch, rej, bought, staleN, setTab, markAllChk, viewProfile }) {
  var act = data.profiles.filter(function (p) { return p.active; });
  var settings = getSettings(data);

  // Count listings per profile
  var countsByProf = {};
  watch.forEach(function (l) { countsByProf[l.profileId] = (countsByProf[l.profileId] || 0) + 1; });

  // Top picks grouped by role (freeform). One role -> one group; no roles -> a
  // single "Top picks" group. Drives the snapshot without any SUV/Commuter
  // hardcoding.
  var roleByProf = {};
  data.profiles.forEach(function (p) { roleByProf[p.id] = p.role || ""; });
  var groups = {};
  watch.forEach(function (l) {
    var r = roleByProf[l.profileId] || "";
    (groups[r] = groups[r] || []).push(l);
  });
  var groupKeys = Object.keys(groups).sort();
  var topByRole = groupKeys.map(function (r) {
    return { role: r, items: groups[r].slice().sort(function (a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); }).slice(0, 2) };
  });

  return (
    <div>
      <div style={S.stats}>
        {[["Watching", watch.length], ["Rejected", rej.length], ["Bought", bought.length], ["Profiles", act.length]].map(function (p) {
          return (<div key={p[0]} style={S.stat}><span style={S.statN}>{p[1]}</span><span style={S.statL}>{p[0]}</span></div>);
        })}
      </div>

      {staleN > 0 && (
        <div style={S.stale}>
          <div style={S.staleT}>⏰ <strong>{staleN}</strong> listing{staleN > 1 ? "s" : ""} not checked in {STALE_DAYS}+ days</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={S.secBtn} onClick={function () { setTab("Results"); }}>Review</button>
            <button style={S.smBtn} onClick={markAllChk}>Mark all fresh</button>
          </div>
        </div>
      )}

      <div style={S.card}>
        <h3 style={S.cardH}>Watchlist by Profile</h3>
        <p style={S.help}>Tap to view filtered watchlist. Import JSON on the Results tab.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {act.map(function (pr) {
            var n = countsByProf[pr.id] || 0;
            return (
              <button key={pr.id} style={S.searchBtn} onClick={function () { viewProfile(pr.id); }}>
                <RoleBadge role={pr.role} extra={{ marginRight: 6, display: "inline-block" }} />
                {pr.name} {n > 0 ? "(" + n + ")" : ""}
              </button>
            );
          })}
          <button style={Object.assign({}, S.searchBtn, { opacity: 0.6 })} onClick={function () { viewProfile("all"); }}>
            All ({watch.length})
          </button>
        </div>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Top Picks {settings.budget ? "· budget $" + Number(settings.budget).toLocaleString() : ""}</h3>
        {watch.length ? (
          <div>
            {topByRole.map(function (g) {
              return (<BG key={g.role || "_"} label={g.role ? "Best " + g.role : "Top picks"} items={g.items} budget={settings.budget} tax={settings.taxRate} />);
            })}
          </div>
        ) : (<p style={S.empty}>No listings yet.</p>)}
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Global Requirements</h3>
        {(data.globalReqs || []).filter(function (r) { return r.active; }).length
          ? (data.globalReqs || []).filter(function (r) { return r.active; }).map(function (r) {
              return (<div key={r.id} style={{ fontSize: 12, color: "#c8c8d0", padding: "2px 0" }}>✓ {r.text}</div>);
            })
          : <p style={S.empty}>None set — add some on the Profiles tab to guide scoring.</p>}
      </div>
    </div>
  );
}

function BG({ label, items, budget, tax }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={S.budL}>{label}</div>
      {items.map(function (l) {
        return (
          <div key={l.id} style={S.budR}>
            <span>{l.year} {l.vehicle} — ${(l.price || 0).toLocaleString()}</span>
            {budget ? <span style={S.budRem}>→ ${calcRem(l.price, budget, tax).toLocaleString()} left</span> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Settings (budget, tagline, search locations) ──
function SettingsCard({ data, save }) {
  var s = getSettings(data);
  var [open, setOpen] = useState(false);
  var [budget, setBudget] = useState(String(s.budget || ""));
  var [tagline, setTagline] = useState(s.tagline || "");
  var [hubs, setHubs] = useState((s.hubs || []).map(function (h) { return { n: h.n || "", z: h.z || "", lat: h.lat, lon: h.lon }; }));

  function setHub(i, key, val) {
    setHubs(function (prev) {
      return prev.map(function (h, j) {
        if (j !== i) return h;
        var nh = Object.assign({}, h, { [key]: val });
        if (key === "z") { nh.lat = undefined; nh.lon = undefined; } // stale coords once zip changes
        return nh;
      });
    });
  }
  function addHub() { setHubs(function (prev) { return prev.concat([{ n: "", z: "" }]); }); }
  function delHub(i) { setHubs(function (prev) { return prev.filter(function (_, j) { return j !== i; }); }); }
  function saveAll() {
    var cleanHubs = hubs.filter(function (h) { return (h.z || "").trim() || (h.n || "").trim(); })
      .map(function (h) { var o = { n: (h.n || "").trim(), z: (h.z || "").trim() }; if (h.lat != null) o.lat = h.lat; if (h.lon != null) o.lon = h.lon; return o; });
    save(Object.assign({}, data, { settings: Object.assign({}, s, { budget: parseInt(budget) || 0, tagline: tagline.trim(), hubs: cleanHubs }) }));
    setOpen(false);
  }

  return (
    <div style={S.card}>
      <div style={S.secH}>
        <h3 style={S.cardH}>Settings</h3>
        <button style={S.secBtn} onClick={function () { setOpen(!open); }}>{open ? "Close" : "Edit"}</button>
      </div>
      {!open ? (
        <p style={S.help}>Budget ${Number(s.budget || 0).toLocaleString()} · {(s.hubs || []).length} search location{(s.hubs || []).length === 1 ? "" : "s"} ({(s.hubs || []).map(function (h) { return h.n || h.z; }).join(", ") || "none"})</p>
      ) : (
        <div>
          <div style={S.grid2}>
            <div style={S.field}><label style={S.lbl}>Total budget ($)</label><input style={S.inp} type="number" value={budget} onChange={function (e) { setBudget(e.target.value); }} /></div>
            <div style={S.field}><label style={S.lbl}>Header tagline</label><input style={S.inp} value={tagline} onChange={function (e) { setTagline(e.target.value); }} /></div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={S.lbl}>Search locations (ZIP is required; name is just a label)</label>
            {hubs.map(function (h, i) {
              return (
                <div key={i} style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input style={Object.assign({}, S.inp, { flex: 1 })} value={h.n} placeholder="Boston MA" onChange={function (e) { setHub(i, "n", e.target.value); }} />
                  <input style={Object.assign({}, S.inp, { width: 90 })} value={h.z} placeholder="02101" onChange={function (e) { setHub(i, "z", e.target.value); }} />
                  <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { delHub(i); }}>×</button>
                </div>
              );
            })}
            <button style={Object.assign({}, S.smBtn, { marginTop: 6 })} onClick={addHub}>+ Add location</button>
          </div>
          <p style={S.help}>Budget powers the "budget left" math; locations are where dealer inventory is searched (~100 mi radius each).</p>
          <button style={Object.assign({}, S.priBtn, { marginTop: 6 })} onClick={saveAll}>Save settings</button>
        </div>
      )}
    </div>
  );
}

// ── Profiles + Global Reqs ──
function ProfilesTab({ data, save, keyOk, scoreModel }) {
  var [ed, setEd] = useState(null);
  var [showIO, setShowIO] = useState(false);
  var [impText, setImpText] = useState("");
  var [impMsg, setImpMsg] = useState(null);
  function importProfiles() {
    var res = parseProfiles(impText);
    if (!res.profiles.length) { setImpMsg({ ok: false, text: res.errors.join(" · ") || "No profiles found" }); return; }
    var existing = data.profiles || [];
    function have(pr) {
      return existing.some(function (e) {
        if (e.id === pr.id) return true;
        var ep = e.params || {};
        return (ep.make || "").toLowerCase() === pr.params.make.toLowerCase()
          && (ep.model || "").toLowerCase() === pr.params.model.toLowerCase()
          && (ep.powertrain || "").toLowerCase() === (pr.params.powertrain || "").toLowerCase();
      });
    }
    var toAdd = res.profiles.filter(function (pr) { return !have(pr); });
    var skipped = res.profiles.length - toAdd.length;
    if (!toAdd.length) { setImpMsg({ ok: true, text: "All " + res.profiles.length + " already present — nothing to add." }); return; }
    save(Object.assign({}, data, { profiles: existing.concat(toAdd) }));
    setImpMsg({ ok: true, text: "Added " + toAdd.map(function (p) { return p.name; }).join(", ") + (skipped ? " · skipped " + skipped + " already present" : "") + (res.errors.length ? " · " + res.errors.length + " invalid" : "") });
    setImpText("");
  }
  function toggleActive(id) { save(Object.assign({}, data, { profiles: data.profiles.map(function (p) { return p.id === id ? Object.assign({}, p, { active: !p.active }) : p; }) })); }
  function delProf(id) { save(Object.assign({}, data, { profiles: data.profiles.filter(function (p) { return p.id !== id; }) })); }
  function addProf() {
    var n = { id: "p-" + Date.now(), name: "New Profile", role: "", active: true,
      params: { make: "", model: "", years: "", trims: "", trimInclude: "", trimExclude: "", maxPrice: 20000, maxMiles: 80000, mustHave: "", niceToHave: "", dealbreakers: "" } };
    // Prepend + open the editor so the new profile is immediately visible (was
    // appended at the bottom of a long list, which read as "nothing happened").
    save(Object.assign({}, data, { profiles: [n].concat(data.profiles || []) }));
    setEd(n.id);
  }
  function updProf(id, upd) {
    save(Object.assign({}, data, { profiles: data.profiles.map(function (p) {
      return p.id === id ? Object.assign({}, p, { name: upd.name, role: upd.role, params: Object.assign({}, p.params, upd.params) }) : p;
    }) }));
    setEd(null);
  }
  function toggleReq(id) { save(Object.assign({}, data, { globalReqs: (data.globalReqs || []).map(function (r) { return r.id === id ? Object.assign({}, r, { active: !r.active }) : r; }) })); }
  var [newReqText, setNewReqText] = useState("");
  var [showAddReq, setShowAddReq] = useState(false);
  var [editReqId, setEditReqId] = useState(null);
  var [editReqText, setEditReqText] = useState("");
  function addReq() {
    if (!newReqText.trim()) return;
    save(Object.assign({}, data, { globalReqs: (data.globalReqs || []).concat({ id: "gr-" + Date.now(), text: newReqText.trim(), active: true }) }));
    setNewReqText(""); setShowAddReq(false);
  }
  function delReq(id) { save(Object.assign({}, data, { globalReqs: (data.globalReqs || []).filter(function (r) { return r.id !== id; }) })); }
  function startEdit(id) { var r = (data.globalReqs || []).find(function (x) { return x.id === id; }); setEditReqId(id); setEditReqText(r ? r.text : ""); }
  function commitEdit() {
    if (!editReqText.trim()) return;
    save(Object.assign({}, data, { globalReqs: (data.globalReqs || []).map(function (x) { return x.id === editReqId ? Object.assign({}, x, { text: editReqText.trim() }) : x; }) }));
    setEditReqId(null);
  }

  return (
    <div>
      <SettingsCard data={data} save={save} />
      <div style={S.card}>
        <div style={S.secH}><h3 style={S.cardH}>Global Requirements</h3><button style={S.secBtn} onClick={function () { setShowAddReq(!showAddReq); }}>+ Add</button></div>
        <p style={S.help}>Apply to ALL profiles — fed to AI scoring (not the search query). Toggle off for soft preferences.</p>
        {showAddReq && (
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input style={Object.assign({}, S.inp, { flex: 1 })} value={newReqText} onChange={function (e) { setNewReqText(e.target.value); }} placeholder="New requirement..." />
            <button style={S.priBtn} onClick={addReq}>Add</button>
          </div>
        )}
        {(data.globalReqs || []).map(function (r) {
          if (editReqId === r.id) {
            return (
              <div key={r.id} style={{ display: "flex", gap: 6, padding: "6px 0", borderBottom: "1px solid #1e2028" }}>
                <input style={Object.assign({}, S.inp, { flex: 1 })} value={editReqText} onChange={function (e) { setEditReqText(e.target.value); }} />
                <button style={S.priBtn} onClick={commitEdit}>Save</button>
                <button style={S.smBtn} onClick={function () { setEditReqId(null); }}>Cancel</button>
              </div>
            );
          }
          return (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #1e2028", opacity: r.active ? 1 : 0.5 }}>
              <button style={Object.assign({}, S.smBtn, { fontSize: 16, padding: "0 4px" })} onClick={function () { toggleReq(r.id); }}>{r.active ? "✓" : "○"}</button>
              <span style={{ flex: 1, fontSize: 13, color: "#c8c8d0" }}>{r.text}</span>
              <button style={S.smBtn} onClick={function () { startEdit(r.id); }}>Edit</button>
              <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { delReq(r.id); }}>×</button>
            </div>
          );
        })}
      </div>
      <div style={S.secH}>
        <h2 style={S.secT}>Vehicle Profiles</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={S.secBtn} onClick={function () { setShowIO(!showIO); setImpMsg(null); }}>{showIO ? "Close" : "Import / export"}</button>
          <button style={S.priBtn} onClick={addProf}>+ Add</button>
        </div>
      </div>
      {showIO && (
        <div style={S.card}>
          <p style={S.help}>Paste a JSON array of profiles to add. Existing profiles (same make + model + powertrain, or id) are skipped — only missing ones are added.</p>
          <textarea style={Object.assign({}, S.ta, { width: "100%", minHeight: 90, boxSizing: "border-box" })} value={impText}
            onChange={function (e) { setImpText(e.target.value); }} placeholder={'[{"name":"Outback","role":"SUV","params":{"make":"Subaru","model":"Outback","years":"2020-2022","maxPrice":25000,"maxMiles":100000}}]'} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button style={S.priBtn} onClick={importProfiles}>Import</button>
            <button style={S.secBtn} onClick={function () { setImpText(JSON.stringify(data.profiles || [], null, 2)); setImpMsg({ ok: true, text: "Current profiles exported below — copy to back up." }); }}>Export current</button>
            {impMsg && <span style={{ fontSize: 12, color: impMsg.ok ? "#2d8659" : "#c44" }}>{impMsg.text}</span>}
          </div>
        </div>
      )}
      {data.profiles.map(function (p) {
        return (
          <div key={p.id} style={Object.assign({}, S.card, { opacity: p.active ? 1 : 0.5 })}>
            <div style={S.profH}>
              <div style={S.profHL}>
                <RoleBadge role={p.role} />
                <strong style={{ fontSize: 15, color: "#e4e4e7" }}>{p.name}</strong>
              </div>
              <div style={S.profA}>
                <button style={S.smBtn} onClick={function () { toggleActive(p.id); }}>{p.active ? "Off" : "On"}</button>
                <button style={S.smBtn} onClick={function () { setEd(ed === p.id ? null : p.id); }}>{ed === p.id ? "Done" : "Edit"}</button>
                <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { delProf(p.id); }}>Del</button>
              </div>
            </div>
            {ed === p.id ? (<ProfEd profile={p} onSave={function (upd) { updProf(p.id, upd); }}
              listings={data.listings.filter(function (l) { return l.profileId === p.id; })} keyOk={keyOk} model={scoreModel} />) : (
              <div style={{ fontSize: 13, color: "#8a8a96", lineHeight: 1.6 }}>
                <div>{p.params.make} {p.params.model} · {p.params.years} · {p.params.trims}</div>
                <div>≤${p.params.maxPrice.toLocaleString()} · ≤{p.params.maxMiles.toLocaleString()} mi</div>
                {p.params.mustHave && <div style={{ marginTop: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "#2d8659" }}>Must:</span> {p.params.mustHave}</div>}
                {(p.params.trimInclude || p.params.trimExclude) && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    {p.params.trimInclude && <span><span style={{ fontSize: 11, fontWeight: 600, color: "#2d8659" }}>Only trims:</span> {p.params.trimInclude} </span>}
                    {p.params.trimExclude && <span><span style={{ fontSize: 11, fontWeight: 600, color: "#d4a017" }}>Exclude trims:</span> {p.params.trimExclude}</span>}
                  </div>
                )}
                {p.params.priceBaseline && <div style={{ marginTop: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "#b89edd" }}>Price baseline:</span> {(p.params.priceBaseline.tiers || []).length} tier(s) — anchors the price score</div>}
                {p.params.dealbreakers && <div style={{ marginTop: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "#c44" }}>Breaks:</span> {p.params.dealbreakers}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProfEd({ profile, onSave, listings, keyOk, model }) {
  var [p, setP] = useState(Object.assign({}, profile.params));
  var [name, setName] = useState(profile.name || "");
  var [role, setRole] = useState(profile.role || "");
  return (
    <div style={S.grid2}>
      <div style={S.field}><label style={S.lbl}>Name</label><input style={S.inp} value={name} onChange={function (e) { setName(e.target.value); }} /></div>
      <div style={S.field}><label style={S.lbl}>Category / role (optional)</label><input style={S.inp} value={role} onChange={function (e) { setRole(e.target.value); }} placeholder="e.g. SUV, Daily, Truck" /></div>
      {[["make", "Make"], ["model", "Model"], ["powertrain", "Powertrain (Hybrid/PHEV/Electric)"], ["years", "Years"], ["trims", "Trims (scoring only)"]].map(function (pair) {
        return (<div key={pair[0]} style={S.field}><label style={S.lbl}>{pair[1]}</label><input style={S.inp} value={p[pair[0]] || ""} onChange={function (e) { setP(Object.assign({}, p, { [pair[0]]: e.target.value })); }} /></div>);
      })}
      <div style={S.field}><label style={S.lbl}>Max Price</label><input style={S.inp} type="number" value={p.maxPrice} onChange={function (e) { setP(Object.assign({}, p, { maxPrice: parseInt(e.target.value) || 0 })); }} /></div>
      <div style={S.field}><label style={S.lbl}>Max Miles</label><input style={S.inp} type="number" value={p.maxMiles} onChange={function (e) { setP(Object.assign({}, p, { maxMiles: parseInt(e.target.value) || 0 })); }} /></div>
      {[["trimInclude", "Trim include (fuzzy, comma-sep)"], ["trimExclude", "Trim exclude (fuzzy, comma-sep)"]].map(function (pair) {
        return (<div key={pair[0]} style={S.field}><label style={S.lbl}>{pair[1]}</label><input style={S.inp} value={p[pair[0]] || ""} onChange={function (e) { setP(Object.assign({}, p, { [pair[0]]: e.target.value })); }} placeholder={pair[0] === "trimExclude" ? "XT, Turbo, Wilderness" : "e.g. Premium, Limited"} /></div>);
      })}
      {[["mustHave", "Must-have (scoring only)"], ["niceToHave", "Nice-to-have (scoring only)"], ["dealbreakers", "Dealbreakers (scoring only)"]].map(function (pair) {
        return (<div key={pair[0]} style={Object.assign({}, S.field, { gridColumn: "1/-1" })}><label style={S.lbl}>{pair[1]}</label><textarea style={S.ta} value={p[pair[0]] || ""} onChange={function (e) { setP(Object.assign({}, p, { [pair[0]]: e.target.value })); }} rows={2} /></div>);
      })}
      <p style={Object.assign({}, S.help, { gridColumn: "1/-1", margin: 0 })}>Make / model / powertrain / years / max price / max miles filter the search. Trim include/exclude are fuzzy (substring) filters applied to candidates on your device (MarketCheck can't filter trims). Trims, must/nice-to-have, and dealbreakers only guide AI scoring.</p>
      <div style={{ gridColumn: "1/-1" }}>
        <BaselineSection baseline={p.priceBaseline} onChange={function (b) { setP(Object.assign({}, p, { priceBaseline: b })); }}
          profileForGen={{ name: name, params: p }} listings={listings || []} keyOk={keyOk} model={model} />
      </div>
      <button style={Object.assign({}, S.priBtn, { gridColumn: "1/-1" })} onClick={function () { onSave({ name: name.trim() || "Profile", role: role.trim(), params: p }); }}>Save profile</button>
    </div>
  );
}

// Per-profile price baseline: AI-generate good/fair/high asking prices per
// (year-range, trim) grounded in the profile's real listings, then edit; the
// values anchor the "price" scoring criterion.
function BaselineSection({ baseline, onChange, profileForGen, listings, keyOk, model }) {
  var [busy, setBusy] = useState(false);
  var [err, setErr] = useState("");
  var withPrice = (listings || []).filter(function (l) { return l.price; });
  async function generate() {
    setBusy(true); setErr("");
    try {
      var sample = withPrice.map(function (l) { return { year: l.year, trim: l.trim, price: l.price, mileage: l.mileage }; });
      var b = await generateBaseline(profileForGen, sample, model);
      if (b) onChange(b);
      else setErr("No baseline returned");
    } catch (e) { setErr((e && e.message) || "Generation failed"); }
    setBusy(false);
  }
  function setField(k, v) { onChange(Object.assign({}, baseline, { [k]: v })); }
  function setTier(i, k, v) { onChange(Object.assign({}, baseline, { tiers: baseline.tiers.map(function (t, j) { return j === i ? Object.assign({}, t, { [k]: v }) : t; }) })); }
  function addTier() { onChange(Object.assign({}, baseline, { tiers: (baseline.tiers || []).concat([{ years: "", trim: "", good: 0, fair: 0, high: 0 }]) })); }
  function delTier(i) { onChange(Object.assign({}, baseline, { tiers: baseline.tiers.filter(function (_, j) { return j !== i; }) })); }
  function setDefault(k, v) { onChange(Object.assign({}, baseline, { default: Object.assign({}, baseline.default, { [k]: v }) })); }
  var numInp = Object.assign({}, S.inp, { width: 78, textAlign: "right", padding: "4px 6px", fontSize: 12 });

  return (
    <div style={{ border: "1px solid #2a3058", borderRadius: 8, padding: 10, background: "#12141c" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <label style={S.lbl}>Price baseline (anchors the "price" score)</label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {keyOk
            ? <button style={Object.assign({}, S.smBtn, { color: "#b89edd" }, busy ? { opacity: 0.6 } : {})} disabled={busy} onClick={generate}>{busy ? "Generating…" : (baseline ? "↻ Regenerate (AI)" : "✨ Generate (AI)")}</button>
            : <span style={{ fontSize: 11, color: "#888" }}>add an Anthropic key to generate</span>}
          {baseline && <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { onChange(undefined); }}>Clear</button>}
        </div>
      </div>
      <p style={Object.assign({}, S.help, { margin: "4px 0" })}>{withPrice.length} priced listing{withPrice.length === 1 ? "" : "s"} on file to ground the estimate. Good/fair/high are asking prices at the reference mileage; the $/1k-mi figure shifts them for higher/lower miles. Edit anything below.</p>
      {err && <div style={{ fontSize: 12, color: "#c44", marginBottom: 6 }}>{err}</div>}
      {baseline && (
        <div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: "#8a8a96" }}>Ref mileage <input style={numInp} type="number" value={baseline.refMileage || 0} onChange={function (e) { setField("refMileage", parseInt(e.target.value) || 0); }} /></label>
            <label style={{ fontSize: 12, color: "#8a8a96" }}>$ / 1k mi <input style={numInp} type="number" value={baseline.perThousandMi || 0} onChange={function (e) { setField("perThousandMi", parseInt(e.target.value) || 0); }} /></label>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
              <thead><tr>{["Years", "Trim", "Good", "Fair", "High", ""].map(function (h) { return (<th key={h} style={{ textAlign: "left", color: "#6b6b76", padding: "2px 6px", fontWeight: 500 }}>{h}</th>); })}</tr></thead>
              <tbody>
                {(baseline.tiers || []).map(function (t, i) {
                  return (
                    <tr key={i}>
                      <td style={{ padding: "2px 4px" }}><input style={Object.assign({}, S.inp, { width: 82, padding: "4px 6px", fontSize: 12 })} value={t.years || ""} onChange={function (e) { setTier(i, "years", e.target.value); }} placeholder="2019-2020" /></td>
                      <td style={{ padding: "2px 4px" }}><input style={Object.assign({}, S.inp, { width: 82, padding: "4px 6px", fontSize: 12 })} value={t.trim || ""} onChange={function (e) { setTier(i, "trim", e.target.value); }} placeholder="XLE" /></td>
                      {["good", "fair", "high"].map(function (k) { return (<td key={k} style={{ padding: "2px 4px" }}><input style={numInp} type="number" value={t[k] || 0} onChange={function (e) { setTier(i, k, parseInt(e.target.value) || 0); }} /></td>); })}
                      <td style={{ padding: "2px 4px" }}><button style={{ background: "none", border: "none", color: "#c44", cursor: "pointer" }} onClick={function () { delTier(i); }}>×</button></td>
                    </tr>
                  );
                })}
                <tr>
                  <td style={{ padding: "2px 4px", color: "#8a8a96" }} colSpan={2}>default (no match)</td>
                  {["good", "fair", "high"].map(function (k) { return (<td key={k} style={{ padding: "2px 4px" }}><input style={numInp} type="number" value={(baseline.default && baseline.default[k]) || 0} onChange={function (e) { setDefault(k, parseInt(e.target.value) || 0); }} /></td>); })}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <button style={Object.assign({}, S.smBtn, { marginTop: 6 })} onClick={addTier}>+ Add tier</button>
        </div>
      )}
    </div>
  );
}

// ── Criteria ──
function CriteriaTab({ data, saveRecalc, save }) {
  var [local, setLocal] = useState(data.criteria);
  var timer = useRef(null);
  var [defaults, setDefaults] = useState({ system: "", guidance: {} });
  useEffect(function () { setLocal(data.criteria); }, [data.criteria]);
  useEffect(function () { var c = false; getScorePrompt().then(function (d) { if (!c) setDefaults(d || { system: "", guidance: {} }); }); return function () { c = true; }; }, []);
  function commit(next) { setLocal(next); clearTimeout(timer.current); timer.current = setTimeout(function () { saveRecalc(Object.assign({}, data, { criteria: next })); }, 600); }
  var tot = local.reduce(function (s, c) { return s + c.weight; }, 0);
  return (
    <div>
      <div style={S.secH}><h2 style={S.secT}>Scoring Criteria</h2>
        <button style={S.secBtn} onClick={function () { commit(local.concat({ id: "c-" + Date.now(), name: "New", weight: 5 })); }}>+ Add</button>
      </div>

      <PromptEditor data={data} save={save} defaultSystem={defaults.system} />

      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={S.lbl}>Total: {tot}</span>{tot !== 100 && <span style={{ color: "#c44", fontSize: 13 }}>⚠ Should = 100</span>}
        </div>
        {local.map(function (c) {
          return (
            <div key={c.id} style={{ marginBottom: 12, borderBottom: "1px solid #1e2028", paddingBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input style={Object.assign({}, S.inp, { flex: 1 })} value={c.name} onChange={function (e) { commit(local.map(function (cc) { return cc.id === c.id ? Object.assign({}, cc, { name: e.target.value }) : cc; })); }} />
                <input style={Object.assign({}, S.inp, { width: 60, textAlign: "center" })} type="number" value={c.weight} onChange={function (e) { commit(local.map(function (cc) { return cc.id === c.id ? Object.assign({}, cc, { weight: parseInt(e.target.value) || 0 }) : cc; })); }} />
                <span style={{ fontSize: 12, color: "#6b6b76" }}>%</span>
                <button style={{ background: "none", border: "none", color: "#c44", fontSize: 16, cursor: "pointer" }} onClick={function () { commit(local.filter(function (cc) { return cc.id !== c.id; })); }}>×</button>
              </div>
              <textarea style={Object.assign({}, S.ta, { width: "100%", boxSizing: "border-box", marginTop: 6, fontSize: 12 })} rows={2}
                value={c.guidance || ""} placeholder={"How AI scores this 1-10 (leave blank for default: " + (defaults.guidance[c.id] || "score how well the listing satisfies it") + ")"}
                onChange={function (e) { commit(local.map(function (cc) { return cc.id === c.id ? Object.assign({}, cc, { guidance: e.target.value }) : cc; })); }} />
            </div>
          );
        })}
        <p style={S.help}>Weights auto-recalculate scores after 0.6s. The per-criterion text is the AI scoring guidance — leave blank to use the built-in default (shown as placeholder).</p>
      </div>
    </div>
  );
}

// View / override the scoring system prompt (the overall instructions the AI
// gets; the per-criterion rubric + your profile/requirements are added below it).
function PromptEditor({ data, save, defaultSystem }) {
  var [open, setOpen] = useState(false);
  var custom = data.scorePrompt || "";
  var [draft, setDraft] = useState(custom);
  useEffect(function () { setDraft(data.scorePrompt || ""); }, [data.scorePrompt]);
  return (
    <div style={S.card}>
      <div style={S.secH}>
        <h3 style={S.cardH}>Scoring prompt {custom ? "· custom" : "· default"}</h3>
        <button style={S.secBtn} onClick={function () { setOpen(!open); }}>{open ? "Close" : "View / edit"}</button>
      </div>
      {open && (
        <div>
          <p style={S.help}>The overall instructions given to the AI for every listing. Your buyer profile, requirements, per-criterion rubric, and the listing data are appended automatically. Leave blank to use the built-in default (shown as placeholder).</p>
          <textarea style={Object.assign({}, S.ta, { width: "100%", boxSizing: "border-box", minHeight: 140, fontSize: 12 })}
            value={draft} placeholder={defaultSystem || "(loading default…)"} onChange={function (e) { setDraft(e.target.value); }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button style={S.priBtn} onClick={function () { save(Object.assign({}, data, { scorePrompt: draft.trim() })); }}>Save</button>
            <button style={S.secBtn} onClick={function () { setDraft(defaultSystem || ""); }}>Load default to edit</button>
            <button style={S.secBtn} onClick={function () { setDraft(""); save(Object.assign({}, data, { scorePrompt: "" })); }}>Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── First-run setup wizard ──
function Wizard({ data, onComplete }) {
  var s = getSettings(data);
  var [step, setStep] = useState(0);
  var [budget, setBudget] = useState(String(s.budget || ""));
  var [hubs, setHubs] = useState((s.hubs || []).map(function (h) { return { n: h.n || "", z: h.z || "", lat: h.lat, lon: h.lon }; }));
  var [keepProfiles, setKeepProfiles] = useState(true);
  var startReqs = (data.globalReqs && data.globalReqs.length) ? data.globalReqs : DEFAULT_REQS;
  var [reqs, setReqs] = useState(startReqs.map(function (r) { return Object.assign({}, r); }));

  function setHub(i, key, val) {
    setHubs(function (prev) { return prev.map(function (h, j) { if (j !== i) return h; var nh = Object.assign({}, h, { [key]: val }); if (key === "z") { nh.lat = undefined; nh.lon = undefined; } return nh; }); });
  }
  function addHub() { setHubs(function (prev) { return prev.concat([{ n: "", z: "" }]); }); }
  function delHub(i) { setHubs(function (prev) { return prev.filter(function (_, j) { return j !== i; }); }); }
  function toggleReq(id) { setReqs(function (prev) { return prev.map(function (r) { return r.id === id ? Object.assign({}, r, { active: !r.active }) : r; }); }); }

  var starterProfiles = data.profiles || [];

  function finish() {
    var profiles = keepProfiles ? starterProfiles : [];
    var n = profiles.filter(function (p) { return p.active; }).length || profiles.length;
    var hubNames = hubs.filter(function (h) { return h.z || h.n; }).map(function (h) { return h.n || h.z; });
    var budgetNum = parseInt(budget) || 0;
    var tagline = (n ? n + " car" + (n > 1 ? "s" : "") : "Car search")
      + (hubNames.length ? " · " + hubNames.join(", ") : "")
      + (budgetNum ? " · ≤$" + Math.round(budgetNum / 1000) + "K" : "");
    var cleanHubs = hubs.filter(function (h) { return (h.z || "").trim() || (h.n || "").trim(); })
      .map(function (h) { var o = { n: (h.n || "").trim(), z: (h.z || "").trim() }; if (h.lat != null) o.lat = h.lat; if (h.lon != null) o.lon = h.lon; return o; });
    onComplete(Object.assign({}, data, {
      settings: Object.assign({}, s, { budget: budgetNum, hubs: cleanHubs, tagline: tagline }),
      profiles: profiles,
      globalReqs: reqs,
      onboarded: true,
    }));
  }

  var steps = ["Welcome", "Budget & locations", "What you're shopping for", "Global rules", "Done"];
  function next() { setStep(function (x) { return Math.min(x + 1, steps.length - 1); }); }
  function back() { setStep(function (x) { return Math.max(x - 1, 0); }); }

  var lbl = { fontSize: 13, color: "#c8c8d0", lineHeight: 1.6, margin: "0 0 8px" };
  var b = { color: "#f0f0f3", fontWeight: 600 };

  return (
    <div style={S.app}>
      <header style={S.header}>
        <div style={S.hRow}><h1 style={S.title}>Set up your search</h1><span style={S.badge}>Step {step + 1}/{steps.length}</span></div>
        <p style={S.sub}>{steps[step]}</p>
      </header>
      <main>
        <div style={S.card}>
          {step === 0 && (
            <div>
              <p style={lbl}>This app tracks used-car listings from dealer inventory across your search areas, scores them against your criteria (optionally with AI), and keeps a watchlist with price-change and still-available tracking.</p>
              <p style={lbl}>A few quick questions to tailor it to you. <span style={b}>Everything here is editable later</span> on the Profiles tab — and the starter cars, locations, and rules below are opinionated defaults (a Northeast hybrid/EV, two-car search) you can keep, change, or clear.</p>
            </div>
          )}
          {step === 1 && (
            <div>
              <p style={lbl}>What's your total budget, and where should we search? <span style={b}>ZIP is required</span> per location; the name is just a label. Each location searches ~100 mi around it.</p>
              <div style={S.grid2}>
                <div style={S.field}><label style={S.lbl}>Total budget ($)</label><input style={S.inp} type="number" value={budget} onChange={function (e) { setBudget(e.target.value); }} placeholder="40000" /></div>
              </div>
              <div style={{ marginTop: 10 }}>
                <label style={S.lbl}>Search locations</label>
                {hubs.map(function (h, i) {
                  return (
                    <div key={i} style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <input style={Object.assign({}, S.inp, { flex: 1 })} value={h.n} placeholder="City label" onChange={function (e) { setHub(i, "n", e.target.value); }} />
                      <input style={Object.assign({}, S.inp, { width: 90 })} value={h.z} placeholder="ZIP" onChange={function (e) { setHub(i, "z", e.target.value); }} />
                      <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { delHub(i); }}>×</button>
                    </div>
                  );
                })}
                <button style={Object.assign({}, S.smBtn, { marginTop: 6 })} onClick={addHub}>+ Add location</button>
              </div>
            </div>
          )}
          {step === 2 && (
            <div>
              <p style={lbl}>You can shop for one car or several. Each "profile" is one vehicle you're hunting (make/model/years/price). Profiles can have an optional <span style={b}>category</span> (e.g. "SUV", "Daily") to group your watchlist — single-car shoppers can ignore it.</p>
              <p style={lbl}>The starter set is the owner's picks: <span style={b}>{starterProfiles.map(function (p) { return p.name; }).join(", ") || "none"}</span> — Northeast hybrid/EV oriented.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button style={Object.assign({}, S.secBtn, keepProfiles ? { borderColor: "#2563eb", color: "#fff" } : {})} onClick={function () { setKeepProfiles(true); }}>
                  {keepProfiles ? "✓ " : ""}Keep the {starterProfiles.length} starter profile{starterProfiles.length === 1 ? "" : "s"} (edit later)
                </button>
                <button style={Object.assign({}, S.secBtn, !keepProfiles ? { borderColor: "#2563eb", color: "#fff" } : {})} onClick={function () { setKeepProfiles(false); }}>
                  {!keepProfiles ? "✓ " : ""}Start blank — I'll add my own
                </button>
              </div>
            </div>
          )}
          {step === 3 && (
            <div>
              <p style={lbl}>Global rules apply to every profile and <span style={b}>guide AI scoring</span> (they don't filter the search). Toggle off any you don't want; add your own on the Profiles tab — they can be as specific as you like, e.g. <span style={b}>"must have heated seats."</span> (Salt-belt rust is already handled by the location scoring criterion.)</p>
              {reqs.length ? reqs.map(function (r) {
                return (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #1e2028", opacity: r.active ? 1 : 0.5 }}>
                    <button style={Object.assign({}, S.smBtn, { fontSize: 16, padding: "0 4px" })} onClick={function () { toggleReq(r.id); }}>{r.active ? "✓" : "○"}</button>
                    <span style={{ flex: 1, fontSize: 13, color: "#c8c8d0" }}>{r.text}</span>
                  </div>
                );
              }) : <p style={S.empty}>No rules — you can add them later on the Profiles tab.</p>}
            </div>
          )}
          {step === 4 && (
            <div>
              <p style={lbl}>All set. Here's the summary:</p>
              <p style={lbl}>• Budget: <span style={b}>${(parseInt(budget) || 0).toLocaleString()}</span><br />
                • Locations: <span style={b}>{hubs.filter(function (h) { return h.z || h.n; }).map(function (h) { return h.n || h.z; }).join(", ") || "none"}</span><br />
                • Profiles: <span style={b}>{keepProfiles ? starterProfiles.length + " starter" : "starting blank"}</span><br />
                • Active rules: <span style={b}>{reqs.filter(function (r) { return r.active; }).length}</span></p>
              <p style={lbl}>To enable AI scoring, add your Anthropic API key on the Results tab afterward.</p>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "space-between" }}>
            <button style={Object.assign({}, S.secBtn, step === 0 ? { opacity: 0.4 } : {})} disabled={step === 0} onClick={back}>Back</button>
            {step < steps.length - 1
              ? <button style={S.priBtn} onClick={next}>Next</button>
              : <button style={S.priBtn} onClick={finish}>Finish setup</button>}
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Admin: allowlist management (admins only) ──
function AdminTab() {
  var [emails, setEmails] = useState(null);
  var [input, setInput] = useState("");
  var [invite, setInvite] = useState(false);
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState(null);

  function load() { listAllowed().then(setEmails).catch(function (e) { setMsg({ ok: false, text: e.message }); }); }
  useEffect(function () { load(); }, []);

  async function add() {
    if (!input.trim()) return;
    setBusy(true); setMsg(null);
    try {
      var r = await addAllowed(input.trim(), invite);
      setInput("");
      var t = "Added " + r.email;
      if (r.invite) t += " · " + r.invite.message;
      setMsg({ ok: !r.invite || r.invite.ok !== false, text: t });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }
  async function remove(email) {
    setBusy(true); setMsg(null);
    try { await removeAllowed(email); load(); } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  return (
    <div>
      <div style={S.secH}><h2 style={S.secT}>Allowlist</h2></div>
      <div style={S.card}>
        <p style={S.help}>Only these emails (plus any in the <code>ALLOWED_EMAILS</code> env var) can sign in and use the app. Changes here write the <code>allowed_emails</code> table and take effect immediately.</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input style={Object.assign({}, S.inp, { flex: 1, minWidth: 180 })} type="email" autoComplete="off" placeholder="person@example.com"
            value={input} onChange={function (e) { setInput(e.target.value); }} onKeyDown={function (e) { if (e.key === "Enter") add(); }} />
          <button style={Object.assign({}, S.priBtn, busy ? { opacity: 0.6 } : {})} disabled={busy || !input.trim()} onClick={add}>{busy ? "…" : "Add"}</button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#8a8a96", marginTop: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={invite} onChange={function (e) { setInvite(e.target.checked); }} />
          Also send a sign-in invite email (Supabase default email is rate-limited / may land in spam)
        </label>
        {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok ? "#2d8659" : "#c44" }}>{msg.text}</div>}
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Allowed emails {emails ? "(" + emails.length + ")" : ""}</h3>
        {emails === null ? <p style={S.empty}>Loading…</p>
          : emails.length === 0 ? <p style={S.empty}>None in the table — the <code>ALLOWED_EMAILS</code> env var still applies.</p>
          : emails.map(function (row) {
              return (
                <div key={row.email} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid #1e2028" }}>
                  <span style={{ flex: 1, fontSize: 13, color: "#c8c8d0" }}>{row.email}</span>
                  {row.added_at && <span style={{ fontSize: 11, color: "#555" }}>{String(row.added_at).slice(0, 10)}</span>}
                  <button style={Object.assign({}, S.smBtn, { color: "#888" })} disabled={busy} onClick={function () { remove(row.email); }}>Remove</button>
                </div>
              );
            })}
      </div>
    </div>
  );
}

// ── Compare ──
function scoreHue(v) { return v >= 7 ? "#2d8659" : v >= 5 ? "#d4a017" : "#c44"; }

function CompareTab({ data }) {
  var profs = data.profiles || [];
  var [sel, setSel] = useState(function () { return profs.map(function (p) { return p.id; }); });
  var [detail, setDetail] = useState(null); // { listing, crit|null, score, text }
  function toggle(id) { setSel(function (prev) { return prev.indexOf(id) > -1 ? prev.filter(function (x) { return x !== id; }) : prev.concat(id); }); }

  var listings = data.listings
    .filter(function (l) { return l.status === "watch" && sel.indexOf(l.profileId) > -1; })
    .slice().sort(function (a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); });

  // Primary-attribute columns. `best` marks which direction "wins" (highlight).
  var specs = [
    { label: "Price", get: function (l) { return l.price; }, fmt: function (v) { return "$" + v.toLocaleString(); }, best: "min" },
    { label: "Mileage", get: function (l) { return l.mileage; }, fmt: function (v) { return v.toLocaleString() + " mi"; }, best: "min" },
    { label: "Year", get: function (l) { return l.year; }, fmt: function (v) { return String(v); }, best: "max" },
    { label: "Dealer", get: function (l) { return l.dealer ? l.dealer + " (" + (l.dealerType || "?") + ")" : ""; }, fmt: function (v) { return v; } },
    { label: "Location", get: function (l) { return [l.location, l.state].filter(Boolean).join(", ") + (isSalt(l.state) ? " 🧂" : ""); }, fmt: function (v) { return v; } },
    { label: "Color", get: function (l) { return l.color; }, fmt: function (v) { return v; } },
    { label: "Days on market", get: function (l) { return l.dom; }, fmt: function (v) { return String(v); } },
  ];

  function bestVal(get, dir) {
    if (listings.length < 2 || !dir) return null;
    var nums = listings.map(get).filter(function (v) { return typeof v === "number" && !isNaN(v); });
    if (!nums.length) return null;
    return dir === "min" ? Math.min.apply(null, nums) : Math.max.apply(null, nums);
  }

  // Columns: total score, primary attributes, then each scoring criterion.
  var cols = [{ key: "score", label: "Score", kind: "score", best: "max", get: function (l) { return l.compositeScore || 0; } }]
    .concat(specs.map(function (s) { return { key: "spec:" + s.label, label: s.label, kind: "spec", best: s.best, get: s.get, fmt: s.fmt }; }))
    .concat((data.criteria || []).map(function (c) { return { key: "crit:" + c.id, label: c.name + " (" + c.weight + ")", kind: "crit", best: "max", crit: c, get: function (l) { return l.scores && l.scores[c.id]; } }; }));
  var bestByCol = {};
  cols.forEach(function (col) { bestByCol[col.key] = bestVal(col.get, col.best); });

  var rowLabel = { position: "sticky", left: 0, background: "#161820", textAlign: "left", padding: "7px 10px", borderBottom: "1px solid #1e2028", minWidth: 150, maxWidth: 210, zIndex: 1, verticalAlign: "top" };
  var cell = { padding: "7px 10px", borderBottom: "1px solid #1e2028", textAlign: "center", whiteSpace: "nowrap", color: "#c8c8d0" };
  var tap = { cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: "3px" };

  function renderCell(l, col) {
    var best = bestByCol[col.key];
    if (col.kind === "score") {
      var sv = l.compositeScore || 0;
      var sBest = best != null && best > 0 && sv === best;
      var sum = l.aiSummary;
      var ss = Object.assign({}, cell, { fontWeight: 700, color: sv ? scoreHue(sv) : "#555" }, sum ? tap : {});
      return (<td key={col.key} style={ss} onClick={sum ? function () { setDetail({ listing: l, crit: null, score: sv, text: sum }); } : undefined}>{sv || "—"}{sBest ? " ★" : ""}</td>);
    }
    if (col.kind === "crit") {
      var cv = l.scores && l.scores[col.crit.id];
      if (cv == null) return (<td key={col.key} style={cell}>—</td>);
      var cBest = best != null && cv === best;
      var rat = l.aiRationales && l.aiRationales[col.crit.id];
      var cs = Object.assign({}, cell, { color: scoreHue(cv), fontWeight: cBest ? 700 : 400 }, rat ? tap : {});
      return (<td key={col.key} style={cs} onClick={rat ? function () { setDetail({ listing: l, crit: col.crit, score: cv, text: rat }); } : undefined}>{cv}{cBest ? " ★" : ""}</td>);
    }
    var v = col.get(l);
    var blank = v == null || v === "" || (typeof v === "number" && isNaN(v));
    var vBest = best != null && typeof v === "number" && v === best;
    return (<td key={col.key} style={Object.assign({}, cell, vBest ? { color: "#2d8659", fontWeight: 700 } : {})}>{blank ? "—" : col.fmt(v)}</td>);
  }

  return (
    <div>
      <div style={S.secH}><h2 style={S.secT}>Compare</h2></div>
      <div style={S.card}>
        <p style={S.help}>Watchlist listings (rows) for the selected profiles, ranked by total score. Best value per column is highlighted (★ / green). Tap an underlined score (or a row's total) for the AI rationale.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {profs.map(function (p) {
            var on = sel.indexOf(p.id) > -1;
            return (
              <button key={p.id} onClick={function () { toggle(p.id); }}
                style={Object.assign({}, S.searchBtn, on ? { borderColor: "#2563eb", color: "#fff" } : { opacity: 0.55 })}>
                {on ? "✓ " : ""}{p.name}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />
          <button style={S.smBtn} onClick={function () { setSel(profs.map(function (p) { return p.id; })); }}>All</button>
          <button style={S.smBtn} onClick={function () { setSel([]); }}>None</button>
        </div>
      </div>

      {listings.length === 0 ? (
        <p style={S.empty}>No watchlist listings for the selected profile(s).</p>
      ) : (
        <div style={Object.assign({}, S.card, { overflowX: "auto", padding: 0 })}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr>
                <th style={Object.assign({}, rowLabel, { color: "#6b6b76", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 500, borderBottom: "1px solid #2a2d38" })}>
                  {listings.length} listing{listings.length > 1 ? "s" : ""}
                </th>
                {cols.map(function (col) {
                  return (<th key={col.key} style={Object.assign({}, cell, { fontSize: 11, fontWeight: 600, borderBottom: "1px solid #2a2d38", color: col.kind === "crit" ? "#b89edd" : "#8a8a96", verticalAlign: "bottom" })}>{col.label}</th>);
                })}
              </tr>
            </thead>
            <tbody>
              {listings.map(function (l, i) {
                var url = l.link || (l.vin ? "https://www.google.com/search?q=" + encodeURIComponent(l.vin) : "");
                var prof = data.profiles.find(function (p) { return p.id === l.profileId; });
                return (
                  <tr key={l.id || i}>
                    <td style={rowLabel}>
                      <div style={{ color: "#f0f0f3", fontWeight: 600 }}>{l.year} {l.vehicle}</div>
                      {l.trim && <div style={{ fontSize: 11, color: "#8a8a96" }}>{l.trim}</div>}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                        {prof && <RoleBadge role={prof.role} />}
                        {url && <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#8ab4f8" }}>view →</a>}
                      </div>
                    </td>
                    {cols.map(function (col) { return renderCell(l, col); })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div style={Object.assign({}, S.card, { borderLeft: "3px solid #b89edd", marginTop: 12 })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13, color: "#f0f0f3" }}>
              {detail.listing.year} {detail.listing.vehicle} — {detail.crit ? detail.crit.name + " · " + detail.score + "/10" : "Overall summary"}
            </strong>
            <button style={S.smBtn} onClick={function () { setDetail(null); }}>Close</button>
          </div>
          <div style={{ fontSize: 13, color: "#c8c8d0", lineHeight: 1.5 }}>{detail.text}</div>
        </div>
      )}
    </div>
  );
}

// ── Help / usage ──
function HelpTab() {
  var li = { fontSize: 13, color: "#c8c8d0", lineHeight: 1.6, margin: "0 0 6px", paddingLeft: 4 };
  var b = { color: "#f0f0f3", fontWeight: 600 };
  var note = { fontSize: 12, color: "#8a8a96", lineHeight: 1.55, margin: "4px 0 0" };
  return (
    <div>
      <div style={S.secH}><h2 style={S.secT}>How this works</h2></div>

      <div style={S.card}>
        <h3 style={S.cardH}>The basic flow</h3>
        <p style={li}><span style={b}>1. Profiles</span> — define the cars you're hunting (make/model/years/trims, price &amp; mileage caps, must-haves, dealbreakers). Active profiles drive every search.</p>
        <p style={li}><span style={b}>2. Sync</span> — pulls matching dealer inventory and reconciles it with what you're already tracking.</p>
        <p style={li}><span style={b}>3. Candidates</span> — brand-new matches land in a review queue. Approve the good ones to your watchlist, skip the rest.</p>
        <p style={li}><span style={b}>4. Watchlist</span> — your tracked listings, scored and sortable, with price-change and still-available tracking.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Tabs</h3>
        <p style={li}><span style={b}>Dashboard</span> — at-a-glance counts, top picks per profile, and a heads-up when watched listings are due for a re-check.</p>
        <p style={li}><span style={b}>Profiles</span> — add/edit/enable the vehicles you're searching for. Each active profile is queried at every hub on sync.</p>
        <p style={li}><span style={b}>Criteria</span> — the weighted factors (price, mileage, condition, etc.) behind each listing's composite score. Editing weights re-scores everything automatically.</p>
        <p style={li}><span style={b}>Results</span> — sync, review candidates, and manage your watchlist. This is where you'll spend most of your time.</p>
        <p style={li}><span style={b}>Compare</span> — side-by-side table of watchlist listings for the profiles you pick, across primary specs and each scoring criterion plus the total; best value per row is highlighted.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Sync &amp; refresh</h3>
        <p style={li}><span style={b}>"↻ Sync"</span> (Results tab) is also your refresh. On each run it updates prices (with a note), refreshes the last-seen date, flags listings that didn't appear this time ("may be sold"), and routes new VINs to Candidates.</p>
        <p style={note}>It runs automatically when you open the app if it's been a while, or on demand. It only refreshes listings that came from dealer sync — manually-added ones aren't touched.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>For review vs. your watchlist</h3>
        <p style={li}>The Results tab keeps "needs a look" separate from "saved": <span style={b}>Candidates</span> (brand-new matches, full cards) and <span style={b}>Updated — review</span> (saved listings whose price changed this sync, shown as compact cards with a link) sit up top. Your <span style={b}>Watchlist</span> below is the stuff you've already saved and reviewed.</p>
        <p style={li}><span style={b}>Approve</span> moves a candidate to the watchlist; <span style={b}>Skip</span> sets it aside (collapsible <span style={b}>Skipped</span> list; won't reappear on future syncs, and is never auto-scored). On an Updated card, <span style={b}>✓ Reviewed</span> returns it to the watchlist; <span style={b}>Reject</span> drops it.</p>
        <p style={li}>From Skipped you can <span style={b}>Restore to queue</span>, send straight to <span style={b}>Watchlist</span>, or <span style={b}>Remove</span> the record.</p>
        <p style={li}><span style={b}>Trim filters</span> (Profiles tab, per profile): fuzzy include/exclude terms applied to candidates on your device, since the search can't filter trims. Candidates that fail land in <span style={b}>Hidden by trim</span> — tap <span style={b}>🚫 Exclude trim</span> on a candidate to hide its trim, or <span style={b}>✓ Show this trim</span> in the hidden list to bring it back.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>AI scoring (optional)</h3>
        <p style={li}>Add your <span style={b}>Anthropic API key</span> in the ✨ AI scoring panel (Results tab) to have each listing scored 1–10 per criterion with a short rationale and an overall summary.</p>
        <p style={li}><span style={b}>Model</span> — pick Sonnet 5 (default, balanced), Opus 4.8 (most nuanced), or Haiku 4.5 (fastest/cheapest). <span style={b}>Auto-score on sync</span> scores only unscored candidates and listings whose price materially changed (never untouched or skipped ones), and is <span style={b}>skipped when there are more than 20 to score</span> — use Score all / per-card then, to avoid burning credits.</p>
        <p style={li}>Score (or Re-score) any single card with its ✨ button, or use <span style={b}>Score all</span> on the candidate queue. After you edit criteria, per-criterion guidance, or the scoring prompt, cards scored under the old settings show <span style={b}>⟳ Re-score (changed)</span>; <span style={b}>✨ Re-score filtered</span> (in the filter bar) re-applies to every candidate + watchlist listing matching the current filters at once.</p>
        <p style={note}>Scoring runs in batches and fills in results as each batch finishes, so partial progress is kept. If a large run is interrupted (e.g. the tab is backgrounded), the finished ones stay scored and the rest are picked up on the next sync/score. The key is validated, stored encrypted server-side, and never shown again — it's only used to score your own listings under your own account. Note: the API is pay-as-you-go and needs credits in the Anthropic Console; a Claude Pro/Max subscription does not include API access.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Tuning the scoring</h3>
        <p style={li}>On the <span style={b}>Criteria</span> tab you can adjust each criterion's <span style={b}>weight</span> and edit the <span style={b}>per-criterion guidance</span> (how the AI scores it 1–10 — leave blank for the built-in default). <span style={b}>Scoring prompt · View / edit</span> shows and lets you override the overall system instructions.</p>
        <p style={li}><span style={b}>Price baseline</span> (in a profile's editor): <span style={b}>Generate (AI)</span> builds good/fair/high asking prices per year-range &amp; trim, grounded in that profile's real synced listings, then you can edit them. The bands anchor the <span style={b}>price</span> criterion so it's scored against concrete numbers instead of the model's guess.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Listings &amp; scores</h3>
        <p style={li}>The big number on a card is the <span style={b}>composite score</span> (your weighted criteria). AI per-criterion scores feed into it; the <span style={b}>✨ AI assessment</span> box shows the summary and a per-criterion breakdown.</p>
        <p style={li}><span style={b}>Statuses</span>: Watchlist (active), Rejected (with a reason, restorable), Purchased. Stale watched listings surface under "Needs check" — confirm with <span style={b}>Still avail</span>.</p>
        <p style={li}><span style={b}>Title note</span>: "✓ Carfax clean title" means confirmed; "ⓘ Title not Carfax-confirmed" just means the dealer didn't state it (verify yourself) — it's not a salvage flag and doesn't affect the score.</p>
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Setup, backup &amp; reset</h3>
        <p style={li}><span style={b}>Setup wizard</span> (footer) re-runs the guided setup (budget, locations, profiles, rules) without wiping data. Budget, search locations, and tagline also live in the <span style={b}>Settings</span> card on the Profiles tab.</p>
        <p style={li}><span style={b}>Export Listings</span> (footer) dumps your listings as JSON to copy and back up. <span style={b}>Import</span> (Results) accepts the same shape.</p>
        <p style={li}>Your data syncs to your account, so signing in elsewhere loads the same watchlist. <span style={b}>Reset All Data</span> (footer) wipes everything and restarts the wizard.</p>
      </div>
    </div>
  );
}

// ── Results ──
function ResultsTab({ data, addListing, updListing, delListing, edListing, setEdListing, markChk,
  ackReview, ackAllReviews,
  candidates, approveCand, approveAll, dismissCand, excludeTrim, showTrim,
  skipped, restoreSkipped, watchSkipped, purgeSkipped,
  importText, setImportText, doImport, importResult, setImportResult,
  filterProf, setFilterProf, doSync, syncing, syncMsg, lastSynced,
  keyStatus, setKeyStatus, autoScore, setAutoScore, scoreBusy, scoreMsg, scoreItems, scoringActive, scoreModel, setScoreModel }) {
  var [showAdd, setShowAdd] = useState(false);
  var [showImport, setShowImport] = useState(false);
  var [filterRole, setFilterRole] = useState("all");
  var [sortBy, setSortBy] = useState("score");

  function sortFn(a, b) {
    if (sortBy === "price") return (a.price || 0) - (b.price || 0);
    if (sortBy === "priceDesc") return (b.price || 0) - (a.price || 0);
    if (sortBy === "mileage") return (a.mileage || 0) - (b.mileage || 0);
    if (sortBy === "mileageDesc") return (b.mileage || 0) - (a.mileage || 0);
    return (b.compositeScore || 0) - (a.compositeScore || 0);
  }

  function applyFilter(list) {
    return list.filter(function (l) {
      if (filterProf !== "all" && l.profileId !== filterProf) return false;
      if (filterRole !== "all") {
        var pr = data.profiles.find(function (p) { return p.id === l.profileId; });
        if (pr && pr.role !== filterRole) return false;
        if (!pr && filterRole !== "?") return false;
      }
      return true;
    });
  }

  var watchRaw = data.listings.filter(function (l) { return l.status === "watch"; });
  // Saved watchlist updated by the last sync (price change) is surfaced for
  // review, separate from the rest of the watchlist, until acknowledged.
  var updatedW = applyFilter(watchRaw.filter(function (l) { return l.reviewPending; })).slice().sort(sortFn);
  var watchFiltered = applyFilter(watchRaw.filter(function (l) { return !l.reviewPending; })).slice().sort(sortFn);
  var staleW = watchFiltered.filter(function (l) { return daysSince(l.lastChecked) >= STALE_DAYS; });
  var freshW = watchFiltered.filter(function (l) { return daysSince(l.lastChecked) < STALE_DAYS; });
  var rejL = applyFilter(data.listings.filter(function (l) { return l.status === "rejected"; })).slice().sort(sortFn);
  var purchL = applyFilter(data.listings.filter(function (l) { return l.status === "purchased"; })).slice().sort(sortFn);

  var activeProfiles = data.profiles.filter(function (p) { return p.active; });
  var roleOpts = [];
  data.profiles.forEach(function (p) { if (p.role && roleOpts.indexOf(p.role) === -1) roleOpts.push(p.role); });

  // Partition candidates by each one's profile trim include/exclude filter.
  function candTrimPass(c) {
    var p = data.profiles.find(function (x) { return x.id === c.profileId; });
    if (!p || !p.params) return true;
    return trimAllowed((c.trim || "") + " " + (c.vehicle || ""), p.params.trimInclude, p.params.trimExclude);
  }
  function trimHideReason(c) {
    var p = data.profiles.find(function (x) { return x.id === c.profileId; });
    if (!p || !p.params) return "filtered";
    var t = ((c.trim || "") + " " + (c.vehicle || "")).toLowerCase();
    var m = (p.params.trimExclude || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean).filter(function (e) { return t.indexOf(e.toLowerCase()) > -1; });
    if (m.length) return "matches exclude: " + m.join(", ");
    if ((p.params.trimInclude || "").trim()) return "not in include list";
    return "filtered";
  }
  var shownCands = candidates.filter(candTrimPass).slice().sort(sortFn);
  var hiddenCands = candidates.filter(function (c) { return !candTrimPass(c); }).slice().sort(sortFn);

  // The active evaluation set the "Re-score filtered" button re-applies criteria
  // to: every visible candidate + watchlist listing matching the current filters
  // (rejected/purchased are decided, skipped are hidden — all excluded).
  var watchFilteredAll = updatedW.concat(staleW, freshW);
  var reScoreCount = shownCands.length + watchFilteredAll.length;

  // Current score-input fingerprint per profile, to flag scores made under
  // now-changed criteria/prompt/profile. Recomputed on every data change (few
  // profiles, cheap hash). `staleOf` looks an item up by its profile.
  var sigByProfile = {};
  data.profiles.forEach(function (p) { sigByProfile[p.id] = scoreInputHash(data, p); });
  var noProfSig = scoreInputHash(data, null);
  function staleOf(item) {
    var sig = item && item.profileId != null && sigByProfile[item.profileId] != null ? sigByProfile[item.profileId] : noProfSig;
    return scoreIsStale(item, sig);
  }
  var staleCount = shownCands.filter(staleOf).length + watchFilteredAll.filter(staleOf).length;

  var [showRej, setShowRej] = useState(false);
  var [showSkipped, setShowSkipped] = useState(false);
  var [showTrimHidden, setShowTrimHidden] = useState(false);

  function cp(l, stale) {
    return { key: l.id, listing: l, data: data, editing: edListing === l.id,
      onEdit: function () { setEdListing(edListing === l.id ? null : l.id); },
      onUpd: function (u) { updListing(l.id, u); setEdListing(null); },
      onStatus: function (s) { updListing(l.id, { status: s }); },
      onDel: function () { delListing(l.id); },
      onChk: function () { markChk(l.id); }, stale: stale, criteriaStale: staleOf(l),
      onScore: function () { scoreItems([], [l]); }, scoreBusy: scoreBusy, keyOk: keyStatus.valid,
      scoring: scoringActive.indexOf(l.id || l.vin) > -1 };
  }

  var totalShown = staleW.length + freshW.length + rejL.length + purchL.length;
  var totalAll = data.listings.length;

  return (
    <div>
      <div style={S.secH}>
        <h2 style={S.secT}>Listings</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={Object.assign({}, S.secBtn, syncing ? { opacity: 0.6 } : {})} disabled={syncing} onClick={function () { doSync(); }}>{syncing ? "Syncing…" : "↻ Sync"}</button>
          <button style={S.secBtn} onClick={function () { setShowImport(!showImport); setShowAdd(false); }}>{showImport ? "Close" : "Import"}</button>
          <button style={S.priBtn} onClick={function () { setShowAdd(!showAdd); setShowImport(false); setEdListing(null); }}>{showAdd ? "Cancel" : "+ Add"}</button>
        </div>
      </div>

      <SyncStatus syncing={syncing} syncMsg={syncMsg} lastSynced={lastSynced} />

      <AiPanel keyStatus={keyStatus} setKeyStatus={setKeyStatus} autoScore={autoScore} setAutoScore={setAutoScore}
        scoreBusy={scoreBusy} scoreMsg={scoreMsg} scoreModel={scoreModel} setScoreModel={setScoreModel} />

      {/* Filter & Sort bar */}
      {totalAll > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <select style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 8px", fontSize: 12 })} value={filterProf} onChange={function (e) { setFilterProf(e.target.value); }}>
            <option value="all">All profiles</option>
            {activeProfiles.map(function (p) { return (<option key={p.id} value={p.id}>{p.name}</option>); })}
          </select>
          {roleOpts.length >= 2 && (
            <select style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 8px", fontSize: 12 })} value={filterRole} onChange={function (e) { setFilterRole(e.target.value); }}>
              <option value="all">All categories</option>
              {roleOpts.map(function (r) { return (<option key={r} value={r}>{r} only</option>); })}
            </select>
          )}
          <select style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 8px", fontSize: 12 })} value={sortBy} onChange={function (e) { setSortBy(e.target.value); }}>
            <option value="score">Sort: Score ↓</option>
            <option value="price">Sort: Price ↑</option>
            <option value="priceDesc">Sort: Price ↓</option>
            <option value="mileage">Sort: Mileage ↑</option>
            <option value="mileageDesc">Sort: Mileage ↓</option>
          </select>
          {keyStatus.valid && reScoreCount > 0 && (
            <button style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 10px", fontSize: 12, cursor: "pointer", color: "#b89edd" },
              staleCount > 0 && !scoreBusy ? { color: "#d4a017", borderColor: "#5a4a17" } : {},
              scoreBusy ? { opacity: 0.6, cursor: "default" } : {})}
              disabled={scoreBusy}
              title={"Re-score every candidate and watchlist listing matching the current filters (skips rejected, purchased, and skipped). Use after editing criteria or the scoring prompt to re-apply them." + (staleCount > 0 ? " " + staleCount + " have scores from since-changed inputs." : "")}
              onClick={function () { scoreItems(shownCands, watchFilteredAll); }}>
              {scoreBusy ? "Scoring…" : ("✨ Re-score filtered (" + reScoreCount + ")" + (staleCount > 0 ? " · " + staleCount + " changed" : ""))}</button>
          )}
          {(filterProf !== "all" || filterRole !== "all") && (
            <span style={{ fontSize: 11, color: "#6b6b76" }}>{totalShown} of {totalAll}</span>
          )}
        </div>
      )}

      {/* Candidates (trim-filtered per profile) */}
      {shownCands.length > 0 && (
        <div style={S.card}>
          <div style={S.secH}>
            <h3 style={S.cardH}>Candidates ({shownCands.length})</h3>
            <div style={{ display: "flex", gap: 6 }}>
              {keyStatus.valid && (
                <button style={Object.assign({}, S.secBtn, scoreBusy ? { opacity: 0.6 } : {})} disabled={scoreBusy}
                  onClick={function () { scoreItems(shownCands, []); }}>{scoreBusy ? "Scoring…" : "✨ Score all"}</button>
              )}
              {shownCands.length > 1 && (<button style={S.priBtn} onClick={approveAll}>Approve All</button>)}
            </div>
          </div>
          {shownCands.map(function (c, i) {
            return (<CandCard key={i} cand={c} onApprove={function () { approveCand(c); }} onDismiss={function () { dismissCand(c); }} data={data}
              onScore={function () { scoreItems([c], []); }} scoreBusy={scoreBusy} keyOk={keyStatus.valid} criteriaStale={staleOf(c)}
              scoring={scoringActive.indexOf(c.id || c.vin) > -1}
              onExcludeTrim={c.trim ? function () { excludeTrim(c); } : null} />);
          })}
        </div>
      )}

      {/* Hidden by a profile's trim exclude/include filter — restorable */}
      {hiddenCands.length > 0 && (
        <div style={S.card}>
          <h3 style={Object.assign({}, S.cardH, { cursor: "pointer", margin: 0, display: "flex", alignItems: "center", gap: 6 })}
            onClick={function () { setShowTrimHidden(!showTrimHidden); }}>
            {showTrimHidden ? "▾" : "▸"} Hidden by trim filter ({hiddenCands.length})
          </h3>
          {showTrimHidden && hiddenCands.map(function (c, i) {
            return (
              <div key={(c.vin || "") + i} style={{ borderTop: "1px solid #1e2028", paddingTop: 8, marginTop: 8 }}>
                <div style={{ fontSize: 13, color: "#c8c8d0" }}>{c.year} {c.vehicle}{c.trim ? " · " + c.trim : ""}</div>
                <div style={{ fontSize: 11, color: "#8a8a96", margin: "2px 0 6px" }}>${(c.price || 0).toLocaleString()} · {(c.mileage || 0).toLocaleString()} mi — {trimHideReason(c)}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button style={Object.assign({}, S.smBtn, { color: "#2d8659" })} onClick={function () { showTrim(c); }}>✓ Show this trim</button>
                  <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { dismissCand(c); }}>Skip</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Updated since last sync — compact review cards, separate from the saved watchlist */}
      {updatedW.length > 0 && (
        <div style={S.card}>
          <div style={S.secH}>
            <h3 style={S.cardH}>Updated — review ({updatedW.length})</h3>
            <button style={S.secBtn} onClick={ackAllReviews}>Mark all reviewed</button>
          </div>
          {updatedW.map(function (l) {
            return (<UpdateCard key={l.id} listing={l} data={data}
              onReviewed={function () { ackReview(l.id); }}
              onReject={function () { updListing(l.id, { status: "rejected", rejectReason: "Reviewed update", reviewPending: false }); }} />);
          })}
        </div>
      )}

      {/* Skipped candidates — restorable */}
      {skipped.length > 0 && (
        <div style={S.card}>
          <h3 style={Object.assign({}, S.cardH, { cursor: "pointer", margin: 0, display: "flex", alignItems: "center", gap: 6 })}
            onClick={function () { setShowSkipped(!showSkipped); }}>
            {showSkipped ? "▾" : "▸"} Skipped ({skipped.length})
          </h3>
          {showSkipped && skipped.map(function (s, i) {
            return (
              <div key={(s.vin || "") + i} style={{ borderTop: "1px solid #1e2028", paddingTop: 8, marginTop: 8 }}>
                <div style={{ fontSize: 13, color: "#c8c8d0" }}>
                  {s.year} {s.vehicle}{s.trim ? " " + s.trim : ""}
                  {s.compositeScore > 0 && <span style={{ marginLeft: 8, fontWeight: 700, color: s.compositeScore >= 7 ? "#2d8659" : s.compositeScore >= 5 ? "#d4a017" : "#c44" }}>{s.compositeScore}</span>}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: "#8a8a96", margin: "2px 0 6px" }}>
                  <span>${(s.price || 0).toLocaleString()}</span>
                  <span>{(s.mileage || 0).toLocaleString()} mi</span>
                  {s.dealer && <span>{s.dealer}</span>}
                  {s.location && <span>{s.location}, {s.state}</span>}
                </div>
                {s.aiSummary && <div style={{ fontSize: 12, color: "#9a9aa6", fontStyle: "italic", marginBottom: 6 }}>{s.aiSummary}</div>}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button style={Object.assign({}, S.smBtn, { color: "#6b9edd" })} onClick={function () { restoreSkipped(s); }}>↩ Restore to queue</button>
                  <button style={Object.assign({}, S.smBtn, { color: "#2d8659" })} onClick={function () { watchSkipped(s); }}>+ Watchlist</button>
                  <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { purgeSkipped(s); }}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Import */}
      {showImport && (
        <div style={S.card}>
          <h3 style={S.cardH}>Import from Claude</h3>
          <p style={S.help}>Paste JSON from a Claude chat session. Array of listing objects. Required: vehicle, year, price, profileId.</p>
          <p style={S.help}>profileIds: {data.profiles.map(function (p) { return p.id; }).join(", ")}</p>
          <textarea style={Object.assign({}, S.ta, { width: "100%", minHeight: 100, marginTop: 8, boxSizing: "border-box" })} value={importText}
            onChange={function (e) { setImportText(e.target.value); }} placeholder={'[\n  {"vehicle":"RAV4 Hybrid XLE","year":2021,"price":23000,"profileId":"rav4-hybrid",...}\n]'} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <button style={S.priBtn} onClick={doImport}>Validate & Preview</button>
            {importResult && importResult.errors.length === 0 && importResult.listings.length > 0 && (
              <span style={{ fontSize: 12, color: "#2d8659" }}>✓ {importResult.listings.length} valid — review candidates above</span>
            )}
          </div>
          {importResult && importResult.errors.length > 0 && (
            <div style={{ marginTop: 8, padding: 10, background: "#1a1012", borderRadius: 6, border: "1px solid #3d1818" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#c44", marginBottom: 4 }}>Validation Errors ({importResult.errors.length})</div>
              {importResult.errors.slice(0, 10).map(function (e, i) {
                return (<div key={i} style={{ fontSize: 11, color: "#e88", padding: "2px 0" }}>• {e}</div>);
              })}
              {importResult.errors.length > 10 && <div style={{ fontSize: 11, color: "#888" }}>...and {importResult.errors.length - 10} more</div>}
            </div>
          )}
          {importResult && importResult.warnings.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {importResult.warnings.map(function (w, i) {
                return (<div key={i} style={{ fontSize: 11, color: "#e8c96a" }}>⚠ {w}</div>);
              })}
            </div>
          )}
        </div>
      )}

      {showAdd && <LForm profiles={data.profiles} criteria={data.criteria} onSave={function (l) { addListing(l); setShowAdd(false); }} />}

      {staleW.length > 0 && (
        <div>
          <h3 style={S.grpT}>⏰ Needs check ({staleW.length})</h3>
          {staleW.map(function (l) { return (<LCard {...cp(l, true)} />); })}
        </div>
      )}
      {freshW.length > 0 && (
        <div>
          <h3 style={S.grpT}>Watchlist ({freshW.length})</h3>
          {freshW.map(function (l) { return (<LCard {...cp(l, false)} />); })}
        </div>
      )}
      {rejL.length > 0 && (
        <div>
          <h3 style={Object.assign({}, S.grpT, { cursor: "pointer", display: "flex", alignItems: "center", gap: 6 })}
            onClick={function () { setShowRej(!showRej); }}>
            {showRej ? "▾" : "▸"} Rejected ({rejL.length})
          </h3>
          {showRej && rejL.map(function (l) { return (<LCard {...cp(l, false)} />); })}
        </div>
      )}
      {purchL.length > 0 && (
        <div>
          <h3 style={S.grpT}>Purchased ({purchL.length})</h3>
          {purchL.map(function (l) { return (<LCard key={l.id} listing={l} data={data} editing={false} onEdit={function () {}} onUpd={function () {}} onStatus={function () {}} onDel={function () {}} onChk={function () {}} stale={false} />); })}
        </div>
      )}

      {!data.listings.length && !candidates.length && !showAdd && !showImport && (
        <div style={S.card}><p style={S.empty}>No listings yet. Use Import above, or + Add to enter one manually.</p></div>
      )}
    </div>
  );
}

function SyncStatus({ syncing, syncMsg, lastSynced }) {
  function fmtWhen(iso) {
    if (!iso) return "never";
    var d = new Date(iso);
    var mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    if (mins < 1440) return Math.floor(mins / 60) + "h ago";
    return d.toISOString().split("T")[0];
  }
  var text, color = "#6b6b76";
  if (syncing) {
    text = "Fetching dealer inventory…";
  } else if (syncMsg && !syncMsg.ok) {
    text = "⚠ " + syncMsg.error;
    color = "#c44";
  } else if (syncMsg && syncMsg.ok) {
    var s = syncMsg.summary || {};
    var parts = [];
    if (s.newCount) parts.push(s.newCount + " new");
    if (s.priceUpdates) parts.push(s.priceUpdates + " price change" + (s.priceUpdates > 1 ? "s" : ""));
    if (s.refreshed) parts.push(s.refreshed + " already watched");
    if (syncMsg.skippedSeen) parts.push(syncMsg.skippedSeen + " skipped (hidden)");
    if (s.notSeen) parts.push(s.notSeen + " not seen");
    var detail = parts.length ? parts.join(" · ") : "no changes";
    text = (syncMsg.mock ? "Mock sync" : "Synced") + " — " + detail + " (from " + (s.fetched || 0) + " found)";
    if (syncMsg.errors && syncMsg.errors.length) {
      text += " · " + syncMsg.errors.length + " query error(s): " + String(syncMsg.errors[0]).slice(0, 240);
      color = "#d4a017";
    }
  } else {
    text = "Last synced: " + fmtWhen(lastSynced);
  }
  return (<div style={{ fontSize: 11, color: color, marginBottom: 10 }}>{text}</div>);
}

// AI scoring controls: key status + management, auto-score toggle, live status.
function AiPanel({ keyStatus, setKeyStatus, autoScore, setAutoScore, scoreBusy, scoreMsg, scoreModel, setScoreModel }) {
  var [open, setOpen] = useState(false);
  var [keyInput, setKeyInput] = useState("");
  var [busy, setBusy] = useState(false);
  var [err, setErr] = useState("");
  var configured = keyStatus.configured;
  var valid = keyStatus.valid;

  async function doSave() {
    if (!keyInput.trim()) return;
    setBusy(true); setErr("");
    try { var s = await saveKey(keyInput.trim()); setKeyStatus(s); setKeyInput(""); setOpen(false); }
    catch (e) { setErr(e.message || "Couldn't save key"); }
    setBusy(false);
  }
  async function doRemove() {
    setBusy(true); setErr("");
    try { var s = await removeKey(); setKeyStatus(s); }
    catch (e) { setErr(e.message || "Couldn't remove key"); }
    setBusy(false);
  }

  var statusText = !configured ? "No Anthropic key set"
    : (valid ? "Key ••••" + (keyStatus.last4 || "") + " active"
             : "Key ••••" + (keyStatus.last4 || "") + " rejected — re-enter");
  var statusColor = !configured ? "#888" : (valid ? "#2d8659" : "#c44");

  return (
    <div style={Object.assign({}, S.card, { padding: 12, marginBottom: 12 })}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, color: "#c8c8d0", fontWeight: 600 }}>✨ AI scoring</span>
          <span style={{ fontSize: 11, color: statusColor }}>{statusText}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <select value={scoreModel} disabled={!valid} onChange={function (e) { setScoreModel(e.target.value); }}
            title="Scoring model" style={Object.assign({}, S.inp, { padding: "4px 6px", fontSize: 12 }, valid ? {} : { opacity: 0.5 })}>
            {SCORE_MODEL_OPTIONS.map(function (m) { return (<option key={m.id} value={m.id}>{m.label}</option>); })}
          </select>
          <label style={{ fontSize: 12, color: valid ? "#c8c8d0" : "#555", display: "flex", alignItems: "center", gap: 5, cursor: valid ? "pointer" : "default" }}>
            <input type="checkbox" checked={autoScore} disabled={!valid} onChange={function (e) { setAutoScore(e.target.checked); }} />
            Auto-score on sync
          </label>
          <button style={S.smBtn} onClick={function () { setOpen(!open); setErr(""); }}>{open ? "Close" : (configured ? "Manage key" : "Add key")}</button>
        </div>
      </div>
      {scoreMsg && (
        <div style={{ fontSize: 12, marginTop: 6, color: scoreMsg.ok ? "#2d8659" : scoreMsg.busy ? "#6b9edd" : "#c44" }}>
          {scoreBusy ? "⏳ " : (scoreMsg.ok ? "✓ " : "")}{scoreMsg.text}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 10, borderTop: "1px solid #1e2028", paddingTop: 10 }}>
          <p style={S.help}>Your Anthropic API key is validated, then stored encrypted server-side and used only to score your own listings under your own account/quota. It's never displayed again. Create one at console.anthropic.com.</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input style={Object.assign({}, S.inp, { flex: 1, minWidth: 180 })} type="password" autoComplete="off"
              placeholder="sk-ant-..." value={keyInput} onChange={function (e) { setKeyInput(e.target.value); }} />
            <button style={Object.assign({}, S.priBtn, { padding: "7px 14px", fontSize: 13 }, busy ? { opacity: 0.6 } : {})} disabled={busy || !keyInput.trim()} onClick={doSave}>{busy ? "Validating…" : "Save"}</button>
            {configured && <button style={S.secBtn} disabled={busy} onClick={doRemove}>Remove</button>}
          </div>
          {err && <div style={{ fontSize: 12, color: "#c44", marginTop: 6 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

// AI assessment readout on a card: overall summary + collapsible per-criterion
// rationales. Renders nothing until a listing has been scored.
function AiBox({ listing, criteria }) {
  var [open, setOpen] = useState(false);
  var summary = listing.aiSummary;
  var rats = listing.aiRationales || {};
  var hasRats = Object.keys(rats).length > 0;
  if (!summary && !hasRats) return null;
  return (
    <div style={{ marginTop: 6, marginBottom: 8, padding: "8px 10px", background: "#161a26", border: "1px solid #2a3058", borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: "#b89edd", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>✨ AI assessment</span>
        {listing.scoredAt && <span style={{ color: "#555", textTransform: "none", letterSpacing: 0 }}>{String(listing.scoredAt).slice(0, 10)}</span>}
      </div>
      {summary && <div style={{ fontSize: 12, color: "#c8c8d0", lineHeight: 1.5 }}>{summary}</div>}
      {hasRats && (
        <button style={{ background: "none", border: "none", color: "#8ab4f8", fontSize: 11, cursor: "pointer", padding: "4px 0 0", fontFamily: "inherit" }}
          onClick={function () { setOpen(!open); }}>{open ? "Hide per-criterion ▴" : "Per-criterion ▾"}</button>
      )}
      {open && hasRats && (
        <div style={{ marginTop: 4 }}>
          {(criteria || []).map(function (c) {
            var r = rats[c.id];
            var s = listing.scores && listing.scores[c.id];
            if (!r && s == null) return null;
            return (
              <div key={c.id} style={{ fontSize: 11, color: "#9a9aa6", padding: "3px 0", borderTop: "1px solid #1e2028", lineHeight: 1.4 }}>
                <strong style={{ color: "#c8c8d0" }}>{c.name}{s != null ? " — " + s + "/10" : ""}</strong>{r ? ": " + r : ""}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Non-scoring title note. carfax_clean_title true = confirmed clean; false =
// just "not stated on the dealer site" (verify), NOT a branded title.
function TitleNote({ listing }) {
  if (listing.carfax_clean_title === true) return (<span style={{ fontSize: 11, color: "#2d8659" }}>✓ Carfax clean title</span>);
  if (listing.carfax_clean_title === false) return (<span style={{ fontSize: 11, color: "#8a8a96" }}>ⓘ Title not Carfax-confirmed — verify</span>);
  return null;
}

function Thumb({ photo, link, alt }) {
  if (!photo) return null;
  var href = link || photo;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginBottom: 8 }}>
      {/* no-referrer defeats referer-based hotlink protection on many dealer CDNs;
          onError hides the image if the host still blocks it or the link is dead. */}
      <img src={photo} alt={alt || ""} loading="lazy" referrerPolicy="no-referrer"
        onError={function (e) { e.target.style.display = "none"; }}
        style={{ width: "100%", maxHeight: 180, objectFit: "cover", borderRadius: 8, border: "1px solid #1e2028", display: "block" }} />
    </a>
  );
}

// Compact card for a saved listing the last sync updated (e.g. price change) —
// distinct from the full new-candidate card. Shows the change + a link; acts
// only "review" / "reject", since the listing is already on the watchlist.
function UpdateCard({ listing, data, onReviewed, onReject }) {
  var l = listing;
  var prof = data.profiles.find(function (p) { return p.id === l.profileId; });
  var ch = l.lastChange;
  var sc = l.compositeScore >= 7 ? "#2d8659" : l.compositeScore >= 5 ? "#d4a017" : "#c44";
  var url = l.link || (l.vin ? "https://www.google.com/search?q=" + encodeURIComponent(l.vin) : "");
  return (
    <div style={Object.assign({}, S.card, { padding: 12, marginBottom: 8, borderLeft: "3px solid #d4a017", background: "#15140e" })}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <strong style={{ fontSize: 14, color: "#f0f0f3" }}>{l.year} {l.vehicle}</strong>
          {prof && <RoleBadge role={prof.role} extra={{ marginLeft: 6 }} />}
          {ch && ch.type === "price" && (
            <div style={{ fontSize: 12, color: ch.dir === "↓" ? "#2d8659" : "#d4a017", marginTop: 3 }}>
              {ch.dir} Price ${Number(ch.from || 0).toLocaleString()} → <strong>${Number(ch.to || 0).toLocaleString()}</strong>
            </div>
          )}
          <div style={{ fontSize: 12, color: "#8a8a96", marginTop: 3 }}>
            {(l.mileage || 0).toLocaleString()} mi{l.dealer ? " · " + l.dealer : ""}{l.location ? " · " + l.location + ", " + l.state : ""}
          </div>
        </div>
        {l.compositeScore > 0 && <span style={{ fontSize: 16, fontWeight: 700, color: sc }}>{l.compositeScore}</span>}
      </div>
      {l.aiSummary && <div style={{ fontSize: 12, color: "#9a9aa6", fontStyle: "italic", margin: "6px 0" }}>{l.aiSummary}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        {url && <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#8ab4f8" }}>{l.link ? "View listing →" : "Search →"}</a>}
        <span style={{ flex: 1 }} />
        <button style={Object.assign({}, S.smBtn, { color: "#2d8659" })} onClick={onReviewed}>✓ Reviewed</button>
        <button style={Object.assign({}, S.smBtn, { color: "#c44" })} onClick={onReject}>Reject</button>
      </div>
    </div>
  );
}

function CandCard({ cand, onApprove, onDismiss, data, onScore, scoreBusy, keyOk, scoring, onExcludeTrim, criteriaStale }) {
  var prof = data.profiles.find(function (p) { return p.id === cand.profileId; });
  var scoreColor = cand.compositeScore >= 7 ? "#2d8659" : cand.compositeScore >= 5 ? "#d4a017" : "#c44";
  return (
    <div style={Object.assign({}, S.card, { borderLeft: "3px solid #2563eb", background: "#12141c" })}>
      <Thumb photo={cand.photo} link={cand.link} alt={cand.year + " " + cand.vehicle} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: 14, color: "#f0f0f3" }}>{cand.year} {cand.vehicle}</strong>
          {cand.trim && <span style={S.trimB}>{cand.trim}</span>}
          {prof && <RoleBadge role={prof.role} extra={{ marginLeft: 6 }} />}
          {cand._dupe && (
            <span style={{ fontSize: 10, color: cand._cheaper ? "#2d8659" : "#888", marginLeft: 6 }}>
              {cand._cheaper ? "↓ cheaper than existing ($" + cand._existingPrice.toLocaleString() + ")" : "≥ existing ($" + cand._existingPrice.toLocaleString() + ")"}
            </span>
          )}
        </div>
        {cand.compositeScore > 0 && <span style={{ fontSize: 18, fontWeight: 700, color: scoreColor }}>{cand.compositeScore}</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: "#8a8a96", marginBottom: 6, lineHeight: 1.8 }}>
        <span>${(cand.price || 0).toLocaleString()}</span>
        <span>{(cand.mileage || 0).toLocaleString()} mi</span>
        {cand.color && <span>{cand.color}</span>}
        {cand.dealer && <span>{cand.dealer} ({cand.dealerType || "?"})</span>}
        {cand.location && <span>{cand.location}, {cand.state} {isSalt(cand.state) ? "🧂" : ""}</span>}
        {cand.dealRating && <span>Deal: {cand.dealRating}</span>}
        <TitleNote listing={cand} />
      </div>
      {cand.notes && <div style={{ fontSize: 12, color: "#6b6b76", fontStyle: "italic", marginBottom: 6 }}>{cand.notes}</div>}
      {/* Listing link */}
      {(function () {
        var url = cand.link || "";
        if (!url && cand.vin) url = "https://www.google.com/search?q=" + encodeURIComponent(cand.vin);
        if (!url) url = "https://www.google.com/search?q=" + encodeURIComponent(cand.year + " " + cand.vehicle + " " + (cand.dealer || "") + " " + (cand.location || ""));
        return (
          <a href={url} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", fontSize: 12, color: "#8ab4f8", background: "#1a2038", border: "1px solid #2a3058", borderRadius: 5, padding: "5px 10px", textDecoration: "none", marginBottom: 6 }}>
            {cand.link ? "View listing →" : cand.vin ? "Search VIN →" : "Search listing →"}
          </a>
        );
      })()}
      {(function () {
        var st = getSettings(data);
        if (!st.budget) return null;
        return (<div style={{ fontSize: 12, color: "#6b9edd", marginBottom: 8 }}>Budget left if bought: <strong>${calcRem(cand.price, st.budget, st.taxRate).toLocaleString()}</strong></div>);
      })()}
      <AiBox listing={cand} criteria={data.criteria} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button style={Object.assign({}, S.priBtn, { padding: "6px 14px", fontSize: 12 })} onClick={onApprove}>✓ Add to Watchlist</button>
        {keyOk && onScore && (
          <button style={Object.assign({}, S.smBtn, { color: criteriaStale ? "#d4a017" : "#b89edd" }, scoreBusy ? { opacity: 0.6 } : {})} disabled={scoreBusy}
            title={criteriaStale ? "Scored under criteria/prompt that have since changed — re-score to refresh" : ""}
            onClick={onScore}>{scoring ? "Scoring…" : (cand.scoredAt ? (criteriaStale ? "⟳ Re-score (changed)" : "✨ Re-score") : "✨ Score")}</button>
        )}
        {onExcludeTrim && <button style={Object.assign({}, S.smBtn, { color: "#d4a017" })} onClick={onExcludeTrim} title={"Hide this trim (" + (cand.trim || "") + ") from candidates"}>🚫 Exclude trim</button>}
        <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={onDismiss}>Skip</button>
      </div>
    </div>
  );
}

function LForm({ profiles, criteria, onSave, initial }) {
  var [f, setF] = useState(initial || {
    profileId: (profiles[0] || {}).id || "", vehicle: "", year: "", trim: "", price: "", mileage: "", dealer: "", dealerType: "franchise",
    location: "", state: "", color: "", vin: "", link: "", dealRating: "", notes: "", status: "watch", scores: {}, rejectReason: ""
  });
  function set(k, v) { setF(function (prev) { return Object.assign({}, prev, { [k]: v }); }); }
  var valid = f.vehicle && f.year && f.price;
  function doSave() {
    if (!valid) { alert("Vehicle, year, and price required."); return; }
    onSave(Object.assign({}, f, { price: parseInt(f.price) || 0, mileage: parseInt(f.mileage) || 0, year: parseInt(f.year) || 0, compositeScore: calcScore(f.scores, criteria) }));
  }
  return (
    <div style={S.card}>
      <h3 style={S.cardH}>{initial ? "Edit" : "Add"} Listing</h3>
      <div style={S.grid2}>
        <div style={S.field}><label style={S.lbl}>Profile</label>
          <select style={S.inp} value={f.profileId} onChange={function (e) { set("profileId", e.target.value); }}>
            {profiles.map(function (p) { return (<option key={p.id} value={p.id}>{p.name} ({p.role})</option>); })}
          </select></div>
        {[["vehicle", "Vehicle *"], ["year", "Year *"], ["trim", "Trim"], ["price", "Price *"], ["mileage", "Mileage"], ["dealer", "Dealer"],
          ["location", "City"], ["state", "State"], ["color", "Color"], ["vin", "VIN"], ["dealRating", "Deal"]
        ].map(function (pair) {
          return (<div key={pair[0]} style={S.field}><label style={S.lbl}>{pair[1]}</label><input style={S.inp} value={f[pair[0]] || ""} onChange={function (e) { set(pair[0], e.target.value); }} /></div>);
        })}
        <div style={Object.assign({}, S.field, { gridColumn: "1/-1" })}><label style={S.lbl}>URL</label><input style={S.inp} value={f.link || ""} onChange={function (e) { set("link", e.target.value); }} /></div>
        <div style={S.field}><label style={S.lbl}>Dealer type</label>
          <select style={S.inp} value={f.dealerType} onChange={function (e) { set("dealerType", e.target.value); }}>
            {["CPO", "franchise", "independent", "private"].map(function (t) { return (<option key={t} value={t}>{t}</option>); })}
          </select></div>
        <div style={Object.assign({}, S.field, { gridColumn: "1/-1" })}><label style={S.lbl}>Notes</label><textarea style={S.ta} value={f.notes || ""} onChange={function (e) { set("notes", e.target.value); }} rows={2} /></div>
        {f.state && isSalt(f.state) && <div style={Object.assign({}, S.saltW, { gridColumn: "1/-1" })}>⚠ Salt-belt ({f.state})</div>}
      </div>
      <h4 style={Object.assign({}, S.cardH, { marginTop: 16 })}>Scores (1–10)</h4>
      <div style={S.grid2}>
        {criteria.map(function (c) {
          return (<div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 11, color: "#8a8a96", flex: 1 }}>{c.name} ({c.weight}%)</label>
            <input style={Object.assign({}, S.inp, { width: 48, textAlign: "center" })} type="number" min="1" max="10"
              value={(f.scores && f.scores[c.id]) || ""} onChange={function (e) { set("scores", Object.assign({}, f.scores || {}, { [c.id]: parseInt(e.target.value) || 0 })); }} />
          </div>);
        })}
      </div>
      <div style={{ marginTop: 8, fontSize: 14, color: "#8a8a8a" }}>Composite: <strong>{calcScore(f.scores || {}, criteria)}</strong>/10</div>
      <button style={Object.assign({}, S.priBtn, { marginTop: 12, opacity: valid ? 1 : 0.4 })} onClick={doSave}>Save</button>
    </div>
  );
}

function LCard({ listing, data, editing, onEdit, onUpd, onStatus, onDel, onChk, stale, onScore, scoreBusy, keyOk, scoring, criteriaStale }) {
  var l = listing;
  var prof = data.profiles.find(function (p) { return p.id === l.profileId; });
  var profRole = prof ? prof.role : "";
  var st = getSettings(data);
  var rem = calcRem(l.price || 0, st.budget, st.taxRate);
  var salt = isSalt(l.state);
  var age = daysSince(l.lastChecked);
  var [confirmDel, setConfirmDel] = useState(false);
  var [showReject, setShowReject] = useState(false);
  var [rejectText, setRejectText] = useState("");

  if (editing) return (<LForm profiles={data.profiles} criteria={data.criteria} initial={l} onSave={onUpd} />);

  var bc = stale ? "#d4a017" : l.status === "watch" ? "#2d8659" : l.status === "rejected" ? "#888" : "#d4a017";
  var sc = l.compositeScore >= 7 ? "#2d8659" : l.compositeScore >= 5 ? "#d4a017" : "#c44";
  return (
    <div style={Object.assign({}, S.card, { borderLeft: "3px solid " + bc })}>
      <Thumb photo={l.photo} link={l.link} alt={l.year + " " + l.vehicle} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: 15, color: "#f0f0f3" }}>{l.year} {l.vehicle}</strong>
          {l.trim && <span style={S.trimB}>{l.trim}</span>}
          <RoleBadge role={profRole} extra={{ marginLeft: 6 }} />
          {!prof && <span style={{ fontSize: 10, color: "#c44", marginLeft: 4 }}>(deleted)</span>}
          {stale && <span style={S.staleB}>⏰ {age}d</span>}
        </div>
        {l.compositeScore > 0 && <span style={{ fontSize: 20, fontWeight: 700, color: sc }}>{l.compositeScore}</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: "#8a8a96", marginBottom: 6, lineHeight: 1.8 }}>
        <span>${(l.price || 0).toLocaleString()}</span>
        <span>{(l.mileage || 0).toLocaleString()} mi</span>
        {l.color && <span>{l.color}</span>}
        <span>{l.dealer} ({l.dealerType})</span>
        <span>{l.location}, {l.state} {salt ? "🧂" : ""}</span>
        {l.dealRating && <span>Deal: {l.dealRating}</span>}
        {l.vin && <span style={{ fontFamily: "monospace", fontSize: 11 }}>VIN: …{l.vin.slice(-6)}</span>}
        <TitleNote listing={l} />
      </div>
      {/* Listing link - prominent button style */}
      {(function () {
        var url = l.link || "";
        if (!url && l.vin) {
          url = "https://www.google.com/search?q=" + encodeURIComponent(l.vin);
        }
        if (!url) {
          url = "https://www.google.com/search?q=" + encodeURIComponent(l.year + " " + l.vehicle + " " + (l.dealer || "") + " " + (l.location || ""));
        }
        return (
          <a href={url} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", fontSize: 13, color: "#8ab4f8", background: "#1a2038", border: "1px solid #2a3058", borderRadius: 6, padding: "6px 12px", textDecoration: "none", marginBottom: 6 }}>
            {l.link ? "View listing →" : l.vin ? "Search VIN →" : "Search listing →"}
          </a>
        );
      })()}
      {st.budget ? <div style={{ fontSize: 12, color: "#6b9edd", marginBottom: 4 }}>Budget left if bought: <strong>${rem.toLocaleString()}</strong></div> : null}
      {l.lastChecked && <div style={{ fontSize: 11, color: "#555" }}>Checked: {l.lastChecked}</div>}
      {l.source === "marketcheck" && l.lastSeen && (
        <div style={{ fontSize: 11, color: l.lastSeen === today() ? "#555" : "#d4a017" }}>
          {l.lastSeen === today() ? "Seen in sync today" : "Last seen in sync: " + l.lastSeen + " (may be sold)"}
        </div>
      )}
      {l.notes && <div style={{ fontSize: 12, color: "#6b6b76", fontStyle: "italic", marginTop: 4 }}>{l.notes}</div>}
      {l.rejectReason && <div style={{ fontSize: 12, color: "#c44", marginTop: 4 }}>Rejected: {l.rejectReason}</div>}

      <AiBox listing={l} criteria={data.criteria} />

      {/* Reject inline UI */}
      {showReject && (
        <div style={{ marginTop: 8, padding: 10, background: "#1a1012", borderRadius: 6, border: "1px solid #3d1818" }}>
          <div style={{ fontSize: 12, color: "#c8c8d0", marginBottom: 6 }}>Reason for rejecting:</div>
          <input style={Object.assign({}, S.inp, { width: "100%", boxSizing: "border-box", marginBottom: 6 })} value={rejectText}
            onChange={function (e) { setRejectText(e.target.value); }} placeholder="e.g. too many miles, accident on Carfax" />
          <div style={{ display: "flex", gap: 6 }}>
            <button style={Object.assign({}, S.priBtn, { background: "#c44", padding: "5px 12px", fontSize: 12 })}
              onClick={function () { onUpd({ status: "rejected", rejectReason: rejectText || "No reason given" }); setShowReject(false); }}>Reject</button>
            <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { setShowReject(false); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Delete confirm inline */}
      {confirmDel && (
        <div style={{ marginTop: 8, padding: 10, background: "#1a1012", borderRadius: 6, border: "1px solid #3d1818" }}>
          <div style={{ fontSize: 12, color: "#e88", marginBottom: 6 }}>Delete this listing permanently?</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={Object.assign({}, S.priBtn, { background: "#c44", padding: "5px 12px", fontSize: 12 })}
              onClick={function () { onDel(); }}>Yes, delete</button>
            <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { setConfirmDel(false); }}>Cancel</button>
          </div>
        </div>
      )}

      {l.status !== "purchased" && !showReject && !confirmDel && (
        <div style={{ display: "flex", gap: 4, marginTop: 8, borderTop: "1px solid #1e2028", paddingTop: 8, flexWrap: "wrap" }}>
          <button style={S.smBtn} onClick={onEdit}>Edit</button>
          {keyOk && onScore && <button style={Object.assign({}, S.smBtn, { color: criteriaStale ? "#d4a017" : "#b89edd" }, scoreBusy ? { opacity: 0.6 } : {})} disabled={scoreBusy} title={criteriaStale ? "Scored under criteria/prompt that have since changed — re-score to refresh" : ""} onClick={onScore}>{scoring ? "Scoring…" : (l.scoredAt ? (criteriaStale ? "⟳ Re-score (changed)" : "✨ Re-score") : "✨ Score")}</button>}
          {l.status === "watch" && stale && <button style={Object.assign({}, S.smBtn, { color: "#2d8659" })} onClick={onChk}>Still avail</button>}
          {l.status === "watch" && <button style={Object.assign({}, S.smBtn, { color: "#c44" })} onClick={function () { setShowReject(true); }}>Reject</button>}
          {l.status === "watch" && <button style={Object.assign({}, S.smBtn, { color: "#d4a017" })} onClick={function () { onStatus("purchased"); }}>Bought</button>}
          {l.status === "rejected" && <button style={S.smBtn} onClick={function () { onStatus("watch"); }}>Restore</button>}
          <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { setConfirmDel(true); }}>Del</button>
        </div>
      )}
    </div>
  );
}

var S = {
  app: { fontFamily: "'IBM Plex Sans','SF Pro Text',-apple-system,sans-serif", maxWidth: 720, margin: "0 auto", padding: "0 16px 24px", background: "#0f1114", minHeight: "100vh", color: "#e4e4e7" },
  loading: { padding: 40, textAlign: "center", color: "#888", fontFamily: "sans-serif" },
  header: { paddingTop: 20, paddingBottom: 8, borderBottom: "1px solid #23262d", marginBottom: 16 },
  hRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 20, fontWeight: 600, margin: 0, color: "#f0f0f3", letterSpacing: "-0.02em" },
  badge: { fontSize: 11, color: "#6b6b76", background: "#1a1c22", padding: "3px 8px", borderRadius: 4 },
  sub: { fontSize: 13, color: "#6b6b76", margin: "4px 0 12px" },
  nav: { display: "flex", gap: 2, overflowX: "auto", paddingBottom: 4 },
  tab: { background: "none", border: "none", color: "#8a8a96", fontSize: 13, padding: "6px 12px", cursor: "pointer", borderRadius: 6, whiteSpace: "nowrap", fontFamily: "inherit" },
  tabOn: { background: "#1e2028", color: "#f0f0f3", fontWeight: 500 },
  footer: { marginTop: 28, padding: "12px 16px", background: "#0f1114", borderTop: "1px solid #1a1c22", textAlign: "center" },
  resetBtn: { background: "none", border: "none", color: "#555", fontSize: 11, cursor: "pointer", fontFamily: "inherit" },
  stats: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 16 },
  stat: { background: "#161820", borderRadius: 8, padding: "14px 12px", textAlign: "center", display: "flex", flexDirection: "column", gap: 2 },
  statN: { fontSize: 22, fontWeight: 600, color: "#f0f0f3" },
  statL: { fontSize: 11, color: "#6b6b76", textTransform: "uppercase", letterSpacing: "0.05em" },
  stale: { background: "#2a2210", border: "1px solid #3d3218", borderRadius: 10, padding: 16, marginBottom: 12 },
  staleT: { fontSize: 13, color: "#e8c96a", marginBottom: 10, lineHeight: 1.5 },
  staleB: { fontSize: 10, color: "#e8c96a", background: "#2a2210", padding: "2px 6px", borderRadius: 3, marginLeft: 6 },
  card: { background: "#161820", borderRadius: 10, padding: 16, marginBottom: 12, border: "1px solid #1e2028" },
  cardH: { fontSize: 14, fontWeight: 600, color: "#c8c8d0", margin: "0 0 10px" },
  secH: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  secT: { fontSize: 16, fontWeight: 600, color: "#e4e4e7", margin: 0 },
  grpT: { fontSize: 13, fontWeight: 600, color: "#8a8a96", textTransform: "uppercase", letterSpacing: "0.04em", margin: "20px 0 8px" },
  priBtn: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, cursor: "pointer", fontWeight: 500, fontFamily: "inherit" },
  secBtn: { background: "#1e2028", color: "#c8c8d0", border: "1px solid #2a2d38", borderRadius: 6, padding: "8px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  smBtn: { background: "none", border: "none", color: "#6b9edd", fontSize: 12, cursor: "pointer", padding: "4px 8px", fontFamily: "inherit" },
  searchBtn: { background: "#1a2038", color: "#8ab4f8", border: "1px solid #2a3058", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  acts: { display: "flex", gap: 8, flexWrap: "wrap" },
  help: { fontSize: 12, color: "#6b6b76", lineHeight: 1.5, margin: "6px 0" },
  empty: { fontSize: 13, color: "#555", textAlign: "center", padding: "16px 0" },
  pill: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #1e2028", flexWrap: "wrap" },
  pillN: { fontWeight: 500, color: "#e4e4e7", fontSize: 14 },
  pillD: { fontSize: 12, color: "#6b6b76" },
  role: { fontSize: 10, fontWeight: 600, color: "#fff", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.05em" },
  profH: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 },
  profHL: { display: "flex", alignItems: "center", gap: 8 },
  profA: { display: "flex", gap: 4, flexWrap: "wrap" },
  inlIn: { background: "#1a1c22", border: "1px solid #2a2d38", borderRadius: 4, color: "#e4e4e7", padding: "4px 8px", fontSize: 14, fontFamily: "inherit" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 },
  field: { display: "flex", flexDirection: "column", gap: 3 },
  lbl: { fontSize: 11, color: "#6b6b76", textTransform: "uppercase", letterSpacing: "0.04em" },
  inp: { background: "#1a1c22", border: "1px solid #2a2d38", borderRadius: 5, color: "#e4e4e7", padding: "7px 10px", fontSize: 13, fontFamily: "inherit" },
  ta: { background: "#1a1c22", border: "1px solid #2a2d38", borderRadius: 5, color: "#e4e4e7", padding: "7px 10px", fontSize: 13, fontFamily: "inherit", resize: "vertical" },
  trimB: { fontSize: 11, background: "#1e2028", color: "#8a8a96", padding: "2px 6px", borderRadius: 3, marginLeft: 6 },
  saltW: { fontSize: 12, color: "#d4a017", background: "#2a2210", padding: "6px 10px", borderRadius: 4 },
  budL: { fontSize: 11, color: "#6b6b76", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 },
  budR: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#c8c8d0", padding: "3px 0", flexWrap: "wrap", gap: 4 },
  budRem: { fontSize: 12, color: "#6b9edd" },
};
