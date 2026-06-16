import { useState, useEffect, useCallback, useRef } from "react";
import storage from "./storage";
import { signOut } from "./Auth";
import { fetchListings, fetchRawSample, reconcile } from "./sync";
import { getKeyStatus, saveKey, removeKey, scoreSet } from "./score";

var AUTO_SYNC_HOURS = 12; // sync-on-open debounce

var STORAGE_KEY = "car-search-data";
var VERSION = 5;
var STALE_DAYS = 5;
var BUDGET = 40000;
var TAX = 0.07;
var SALT = new Set("CT,MA,NH,VT,ME,NY,NJ,PA,OH,MI,WI,MN,IL,IN,IA,MD,DE,WV,RI".split(","));

var DEFAULT_REQS = [
  { id: "clean-title", text: "Clean title (no salvage, rebuilt, or branded)", active: true },
  { id: "no-accidents", text: "No accident history", active: true },
  { id: "no-gold", text: "No gold exterior color", active: true },
  { id: "no-mech", text: "No significant mechanical issues", active: true },
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

var SOURCES = ["CarGurus", "Cars.com", "AutoTempest", "Carvana", "CarMax", "Edmunds", "TrueCar", "FB Marketplace"];
var HUBS = [
  { n: "Boston MA", z: "02101", lat: 42.3601, lon: -71.0589 },
  { n: "Durham NC", z: "27701", lat: 35.994, lon: -78.8986 },
];

// ── Utility ──
function calcRem(p) { return Math.round((BUDGET - p * (1 + TAX)) / (1 + TAX)); }
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
function applyScore(obj, r, crit) {
  var scores = Object.assign({}, obj.scores || {}, r.scores || {});
  return Object.assign({}, obj, {
    scores: scores,
    aiSummary: r.summary || obj.aiSummary || "",
    aiRationales: r.rationales || obj.aiRationales || {},
    scoredAt: new Date().toISOString(),
    compositeScore: calcScore(scores, crit),
  });
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
  data.version = VERSION;
  return data;
}

// ── Tabs ──
var TABS = ["Dashboard", "Profiles", "Criteria", "Queries", "Results"];

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
  var [queries, setQueries] = useState([]);
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
          var d2 = { profiles: DEFAULT_PROFILES, criteria: DEFAULT_CRITERIA, globalReqs: DEFAULT_REQS, listings: [], version: VERSION };
          setData(d2);
          await storage.set(STORAGE_KEY, JSON.stringify(d2));
        }
      } catch (e) {
        console.error("Init:", e);
        // DO NOT overwrite storage on error - just use defaults in memory
        setData({ profiles: DEFAULT_PROFILES, criteria: DEFAULT_CRITERIA, globalReqs: DEFAULT_REQS, listings: [], version: VERSION });
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
  var [scoreMsg, setScoreMsg] = useState(null);

  useEffect(function () {
    var cancelled = false;
    getKeyStatus().then(function (s) { if (!cancelled) setKeyStatus(s); });
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
    var ctx = { criteria: data.criteria, globalReqs: data.globalReqs || [], profileById: profileById };
    setScoreBusy(true);
    setScoreMsg({ busy: true, text: "Scoring " + all.length + " listing" + (all.length > 1 ? "s" : "") + "…" });
    try {
      var pairs = await scoreSet(all, ctx, function (d, t) { setScoreMsg({ busy: true, text: "Scoring " + d + "/" + t + "…" }); });
      var candRes = new Map();
      var byId = {};
      pairs.forEach(function (p) {
        if (!p.result || !p.result.ok) return;
        if (p.item.id) byId[p.item.id] = p.result; else candRes.set(p.item, p.result);
      });
      if (candRes.size) {
        setCandidates(function (prev) {
          return prev.map(function (c) { var r = candRes.get(c); return r ? applyScore(c, r, data.criteria) : c; });
        });
      }
      if (Object.keys(byId).length) {
        patchListings(function (list) {
          return list.map(function (l) { return byId[l.id] ? applyScore(l, byId[l.id], data.criteria) : l; });
        });
      }
      var ok = pairs.filter(function (p) { return p.result && p.result.ok; }).length;
      setScoreMsg({ ok: true, text: "Scored " + ok + "/" + pairs.length + (ok < pairs.length ? " (" + (pairs.length - ok) + " failed)" : "") });
    } catch (e) {
      console.error("Score:", e);
      scoreErr(e);
    }
    setScoreBusy(false);
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
      var res = await fetchListings(active, HUBS, opts);
      var rec = reconcile(data.listings, res.listings, today());
      var decorated = rec.candidates.map(function (c) {
        return Object.assign({}, c, { compositeScore: calcScore(c.scores, data.criteria), _candidate: true });
      });
      setCandidates(function (prev) {
        var seen = {};
        prev.forEach(function (c) { if (c.vin) seen[c.vin] = true; });
        return prev.concat(decorated.filter(function (c) { return !c.vin || !seen[c.vin]; }));
      });
      if (res.errors && res.errors.length) console.warn("Sync query errors:", res.errors);
      // Which existing listings had their price change this run — candidates for
      // a re-score alongside the brand-new candidates.
      var prevPrice = {};
      data.listings.forEach(function (l) { if (l.id) prevPrice[l.id] = l.price; });
      var changed = rec.listings.filter(function (l) { return l.id && prevPrice[l.id] != null && l.price !== prevPrice[l.id]; });
      await save(Object.assign({}, data, { listings: rec.listings, lastSynced: new Date().toISOString() }));
      setSyncMsg({ ok: true, summary: rec.summary, errors: res.errors, mock: res.mock });
      setSyncing(false);
      // Auto-score new candidates + price-changed listings (best-effort; quiet
      // on failure for background syncs). Not awaited — sync is already done.
      if (autoScore && keyStatus.valid && !scoreBusy && (decorated.length || changed.length)) {
        scoreItems(decorated, changed);
      }
      return;
    } catch (e) {
      console.error("Sync:", e);
      if (!auto) setSyncMsg({ ok: false, error: e.message });
    }
    setSyncing(false);
  }, [data, syncing, save, autoScore, keyStatus, scoreBusy, scoreItems]);

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
      return fetchRawSample(active, HUBS).then(function (r) { console.log("[rawSync]", r); return r; });
    };
  }, [data]);

  // Runs one live MarketCheck query and shows raw vs normalized output on-screen
  // (mobile-friendly equivalent of window.__rawSync()).
  var runRawDebug = useCallback(async function () {
    if (!data || rawBusy) return;
    setRawBusy(true); setRawDebug("");
    try {
      var active = data.profiles.filter(function (p) { return p.active; });
      var r = await fetchRawSample(active, HUBS);
      setRawDebug(JSON.stringify(r, null, 2));
    } catch (e) { setRawDebug("Error: " + (e && e.message ? e.message : String(e))); }
    setRawBusy(false);
  }, [data, rawBusy]);

  var genQueries = useCallback(function () {
    if (!data) return;
    var qs = [];
    data.profiles.filter(function (p) { return p.active; }).forEach(function (pr) {
      var p = pr.params;
      var yr = p.years.replace(/\s/g, "").split(",")[0].split("-")[0];
      HUBS.forEach(function (h) {
        SOURCES.forEach(function (src) {
          qs.push({ pn: pr.name, hub: h.n, src: src,
            query: "used " + p.make + " " + p.model + " " + yr + " near " + h.n + " under " + p.maxPrice,
            note: p.years + " " + p.trims + ", max $" + p.maxPrice.toLocaleString() + ", max " + p.maxMiles.toLocaleString() + " mi" });
        });
      });
    });
    setQueries(qs);
    setTab("Queries");
  }, [data, setTab]);

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
    var newList = data.listings.slice();
    candidates.forEach(function (cand) {
      var nl = Object.assign({}, cand, {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
        addedDate: today(), lastChecked: today(), _candidate: undefined, _dupe: undefined, _existingPrice: undefined, _cheaper: undefined
      });
      newList = dedupInsert(newList, nl);
    });
    save(Object.assign({}, data, { listings: newList }));
    setCandidates([]);
  }, [data, candidates, save]);

  var dismissCand = useCallback(function (cand) {
    setCandidates(function (prev) { return prev.filter(function (c) { return c !== cand; }); });
  }, []);

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
  var markAllChk = useCallback(function () {
    if (!data) return;
    var t = today();
    save(Object.assign({}, data, { listings: data.listings.map(function (l) { return l.status === "watch" ? Object.assign({}, l, { lastChecked: t }) : l; }) }));
  }, [data, save]);

  var [confirmReset, setConfirmReset] = useState(false);
  var reset = useCallback(async function () {
    if (!confirmReset) { setConfirmReset(true); return; }
    await save({ profiles: DEFAULT_PROFILES, criteria: DEFAULT_CRITERIA, globalReqs: DEFAULT_REQS, listings: [], version: VERSION });
    setCandidates([]);
    setConfirmReset(false);
  }, [save, confirmReset]);

  if (loading) return (<div style={S.loading}>Loading...</div>);
  if (!data) return (<div style={S.loading}>Error loading data</div>);

  var watch = data.listings.filter(function (l) { return l.status === "watch"; });
  var staleN = watch.filter(function (l) { return daysSince(l.lastChecked) >= STALE_DAYS; }).length;
  var rej = data.listings.filter(function (l) { return l.status === "rejected"; });
  var bought = data.listings.filter(function (l) { return l.status === "purchased"; });
  var roleOf = function (l) { var pr = data.profiles.find(function (p) { return p.id === l.profileId; }); return pr ? pr.role : null; };
  var suvW = watch.filter(function (l) { return roleOf(l) === "SUV"; });
  var comW = watch.filter(function (l) { return roleOf(l) === "Commuter"; });

  return (
    <div style={S.app}>
      <header style={S.header}>
        <div style={S.hRow}>
          <h1 style={S.title}>Car Search Tracker</h1>
          <span style={S.badge}>{saving ? "Saving..." : "Saved ✓"}</span>
        </div>
        <p style={S.sub}>2-car · Boston + Durham · ≤$40K</p>
        <nav style={S.nav}>
          {TABS.map(function (t) {
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
          <DashView data={data} watch={watch} rej={rej} bought={bought} suvW={suvW} comW={comW}
            staleN={staleN} genQueries={genQueries} setTab={setTab} markAllChk={markAllChk} viewProfile={viewProfile} />
        )}
        {tab === "Profiles" && <ProfilesTab data={data} save={save} />}
        {tab === "Criteria" && <CriteriaTab data={data} saveRecalc={saveRecalc} />}
        {tab === "Queries" && <QueriesTab queries={queries} gen={genQueries} />}
        {tab === "Results" && (
          <ResultsTab data={data} addListing={addListing} updListing={updListing} delListing={delListing}
            edListing={edListing} setEdListing={setEdListing} markChk={markChk}
            candidates={candidates} approveCand={approveCand}
            approveAll={approveAll} dismissCand={dismissCand}
            importText={importText} setImportText={setImportText} doImport={doImport} importResult={importResult} setImportResult={setImportResult}
            filterProf={filterProf} setFilterProf={setFilterProf}
            doSync={doSync} syncing={syncing} syncMsg={syncMsg} lastSynced={data.lastSynced}
            keyStatus={keyStatus} setKeyStatus={setKeyStatus} autoScore={autoScore} setAutoScore={setAutoScore}
            scoreBusy={scoreBusy} scoreMsg={scoreMsg} scoreItems={scoreItems} />
        )}
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
function DashView({ data, watch, rej, bought, suvW, comW, staleN, genQueries, setTab, markAllChk, viewProfile }) {
  var act = data.profiles.filter(function (p) { return p.active; });
  var topS = suvW.slice().sort(function (a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); }).slice(0, 2);
  var topC = comW.slice().sort(function (a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); }).slice(0, 2);

  // Count listings per profile
  var countsByProf = {};
  watch.forEach(function (l) { countsByProf[l.profileId] = (countsByProf[l.profileId] || 0) + 1; });

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
                <span style={Object.assign({}, S.role, { background: pr.role === "SUV" ? "#1a5c3a" : "#1a3c5c", marginRight: 6, display: "inline-block" })}>{pr.role}</span>
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
        <h3 style={S.cardH}>Budget Snapshot</h3>
        {(topS.length || topC.length) ? (
          <div>
            {topS.length > 0 && <BG label="Best SUV" items={topS} other="commuter" />}
            {topC.length > 0 && <BG label="Best commuter" items={topC} other="SUV" />}
          </div>
        ) : (<p style={S.empty}>No listings yet.</p>)}
      </div>

      <div style={S.card}>
        <h3 style={S.cardH}>Global Requirements</h3>
        {(data.globalReqs || []).filter(function (r) { return r.active; }).map(function (r) {
          return (<div key={r.id} style={{ fontSize: 12, color: "#c8c8d0", padding: "2px 0" }}>✓ {r.text}</div>);
        })}
      </div>

      <div style={S.card}><h3 style={S.cardH}>Pairing Calculator</h3><PairCalc /></div>
    </div>
  );
}

function BG({ label, items, other }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={S.budL}>{label}</div>
      {items.map(function (l) {
        return (
          <div key={l.id} style={S.budR}>
            <span>{l.year} {l.vehicle} — ${(l.price || 0).toLocaleString()}</span>
            <span style={S.budRem}>→ ${calcRem(l.price).toLocaleString()} for {other}</span>
          </div>
        );
      })}
    </div>
  );
}

function PairCalc() {
  var [sp, setSp] = useState("");
  var [cp, setCp] = useState("");
  var s = parseInt(sp) || 0, c = parseInt(cp) || 0;
  var tot = Math.round((s + c) * (1 + TAX)), diff = BUDGET - tot;
  return (
    <div>
      <div style={S.calcR}><label style={S.calcL}>SUV $</label><input style={S.calcI} type="number" value={sp} onChange={function (e) { setSp(e.target.value); }} placeholder="22000" /></div>
      <div style={S.calcR}><label style={S.calcL}>Commuter $</label><input style={S.calcI} type="number" value={cp} onChange={function (e) { setCp(e.target.value); }} placeholder="16000" /></div>
      {(s > 0 || c > 0) && (
        <div style={{ fontSize: 13, color: "#c8c8d0", lineHeight: 1.8, marginTop: 4 }}>
          <div>After ~7% tax: <strong>${tot.toLocaleString()}</strong></div>
          <div style={{ color: diff >= 0 ? "#2d8659" : "#c44" }}>{diff >= 0 ? "$" + diff.toLocaleString() + " under ✓" : "$" + Math.abs(diff).toLocaleString() + " over ✗"}</div>
        </div>
      )}
    </div>
  );
}

// ── Profiles + Global Reqs ──
function ProfilesTab({ data, save }) {
  var [ed, setEd] = useState(null);
  function toggleActive(id) { save(Object.assign({}, data, { profiles: data.profiles.map(function (p) { return p.id === id ? Object.assign({}, p, { active: !p.active }) : p; }) })); }
  function delProf(id) { save(Object.assign({}, data, { profiles: data.profiles.filter(function (p) { return p.id !== id; }) })); }
  function addProf() {
    var n = { id: "p-" + Date.now(), name: "New Profile", role: "Commuter", active: true,
      params: { make: "", model: "", years: "", trims: "", maxPrice: 20000, maxMiles: 80000, mustHave: "", niceToHave: "", dealbreakers: "" } };
    save(Object.assign({}, data, { profiles: data.profiles.concat(n) })); setEd(n.id);
  }
  function updProf(id, params) { save(Object.assign({}, data, { profiles: data.profiles.map(function (p) { return p.id === id ? Object.assign({}, p, { params: Object.assign({}, p.params, params) }) : p; }) })); setEd(null); }
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
      <div style={S.card}>
        <div style={S.secH}><h3 style={S.cardH}>Global Requirements</h3><button style={S.secBtn} onClick={function () { setShowAddReq(!showAddReq); }}>+ Add</button></div>
        <p style={S.help}>Apply to ALL profiles. Toggle off for soft preferences.</p>
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
      <div style={S.secH}><h2 style={S.secT}>Vehicle Profiles</h2><button style={S.priBtn} onClick={addProf}>+ Add</button></div>
      {data.profiles.map(function (p) {
        return (
          <div key={p.id} style={Object.assign({}, S.card, { opacity: p.active ? 1 : 0.5 })}>
            <div style={S.profH}>
              <div style={S.profHL}>
                <span style={Object.assign({}, S.role, { background: p.role === "SUV" ? "#1a5c3a" : "#1a3c5c" })}>{p.role}</span>
                <strong style={{ fontSize: 15, color: "#e4e4e7" }}>{p.name}</strong>
              </div>
              <div style={S.profA}>
                <button style={S.smBtn} onClick={function () { toggleActive(p.id); }}>{p.active ? "Off" : "On"}</button>
                <button style={S.smBtn} onClick={function () { setEd(ed === p.id ? null : p.id); }}>{ed === p.id ? "Done" : "Edit"}</button>
                <button style={S.smBtn} onClick={function () { save(Object.assign({}, data, { profiles: data.profiles.map(function (pp) { return pp.id === p.id ? Object.assign({}, pp, { role: pp.role === "SUV" ? "Commuter" : "SUV" }) : pp; }) })); }}>{p.role === "SUV" ? "→Com" : "→SUV"}</button>
                <button style={Object.assign({}, S.smBtn, { color: "#888" })} onClick={function () { delProf(p.id); }}>Del</button>
              </div>
            </div>
            {ed === p.id ? (<ProfEd profile={p} onSave={function (params) { updProf(p.id, params); }} />) : (
              <div style={{ fontSize: 13, color: "#8a8a96", lineHeight: 1.6 }}>
                <div>{p.params.make} {p.params.model} · {p.params.years} · {p.params.trims}</div>
                <div>≤${p.params.maxPrice.toLocaleString()} · ≤{p.params.maxMiles.toLocaleString()} mi</div>
                {p.params.mustHave && <div style={{ marginTop: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "#2d8659" }}>Must:</span> {p.params.mustHave}</div>}
                {p.params.dealbreakers && <div style={{ marginTop: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: "#c44" }}>Breaks:</span> {p.params.dealbreakers}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProfEd({ profile, onSave }) {
  var [p, setP] = useState(Object.assign({}, profile.params));
  return (
    <div style={S.grid2}>
      {[["make", "Make"], ["model", "Model"], ["powertrain", "Powertrain (Hybrid/PHEV/Electric)"], ["years", "Years"], ["trims", "Trims"]].map(function (pair) {
        return (<div key={pair[0]} style={S.field}><label style={S.lbl}>{pair[1]}</label><input style={S.inp} value={p[pair[0]] || ""} onChange={function (e) { setP(Object.assign({}, p, { [pair[0]]: e.target.value })); }} /></div>);
      })}
      <div style={S.field}><label style={S.lbl}>Max Price</label><input style={S.inp} type="number" value={p.maxPrice} onChange={function (e) { setP(Object.assign({}, p, { maxPrice: parseInt(e.target.value) || 0 })); }} /></div>
      <div style={S.field}><label style={S.lbl}>Max Miles</label><input style={S.inp} type="number" value={p.maxMiles} onChange={function (e) { setP(Object.assign({}, p, { maxMiles: parseInt(e.target.value) || 0 })); }} /></div>
      {[["mustHave", "Must-have"], ["niceToHave", "Nice-to-have"], ["dealbreakers", "Dealbreakers"]].map(function (pair) {
        return (<div key={pair[0]} style={Object.assign({}, S.field, { gridColumn: "1/-1" })}><label style={S.lbl}>{pair[1]}</label><textarea style={S.ta} value={p[pair[0]] || ""} onChange={function (e) { setP(Object.assign({}, p, { [pair[0]]: e.target.value })); }} rows={2} /></div>);
      })}
      <button style={S.priBtn} onClick={function () { onSave(p); }}>Save</button>
    </div>
  );
}

// ── Criteria ──
function CriteriaTab({ data, saveRecalc }) {
  var [local, setLocal] = useState(data.criteria);
  var timer = useRef(null);
  useEffect(function () { setLocal(data.criteria); }, [data.criteria]);
  function commit(next) { setLocal(next); clearTimeout(timer.current); timer.current = setTimeout(function () { saveRecalc(Object.assign({}, data, { criteria: next })); }, 600); }
  var tot = local.reduce(function (s, c) { return s + c.weight; }, 0);
  return (
    <div>
      <div style={S.secH}><h2 style={S.secT}>Scoring Criteria</h2>
        <button style={S.secBtn} onClick={function () { commit(local.concat({ id: "c-" + Date.now(), name: "New", weight: 5 })); }}>+ Add</button>
      </div>
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={S.lbl}>Total: {tot}</span>{tot !== 100 && <span style={{ color: "#c44", fontSize: 13 }}>⚠ Should = 100</span>}
        </div>
        {local.map(function (c) {
          return (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <input style={Object.assign({}, S.inp, { flex: 1 })} value={c.name} onChange={function (e) { commit(local.map(function (cc) { return cc.id === c.id ? Object.assign({}, cc, { name: e.target.value }) : cc; })); }} />
              <input style={Object.assign({}, S.inp, { width: 60, textAlign: "center" })} type="number" value={c.weight} onChange={function (e) { commit(local.map(function (cc) { return cc.id === c.id ? Object.assign({}, cc, { weight: parseInt(e.target.value) || 0 }) : cc; })); }} />
              <span style={{ fontSize: 12, color: "#6b6b76" }}>%</span>
              <button style={{ background: "none", border: "none", color: "#c44", fontSize: 16, cursor: "pointer" }} onClick={function () { commit(local.filter(function (cc) { return cc.id !== c.id; })); }}>×</button>
            </div>
          );
        })}
        <p style={S.help}>Auto-recalculates all scores after 0.6s.</p>
      </div>
    </div>
  );
}

// ── Queries ──
function QueriesTab({ queries, gen }) {
  useEffect(function () { if (!queries.length) gen(); }, [queries.length, gen]);
  var grp = {};
  queries.forEach(function (q) { if (!grp[q.pn]) grp[q.pn] = []; grp[q.pn].push(q); });
  return (
    <div>
      <div style={S.secH}><h2 style={S.secT}>Search Queries</h2><button style={S.secBtn} onClick={gen}>Regen</button></div>
      <div style={S.card}>
        <p style={S.help}>Copy these queries to search each source manually, then import results as JSON on the Results tab.</p>
        <p style={S.help}>Sources: {SOURCES.join(", ")}</p>
      </div>
      {Object.entries(grp).map(function (entry) {
        return (
          <div key={entry[0]} style={S.card}>
            <h3 style={S.cardH}>{entry[0]}</h3>
            {entry[1].map(function (q, i) {
              return (
                <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #1e2028" }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 2 }}>
                    <span style={S.srcB}>{q.src}</span><span style={S.hubB}>{q.hub}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#6b6b76" }}>{q.note}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── Results ──
function ResultsTab({ data, addListing, updListing, delListing, edListing, setEdListing, markChk,
  candidates, approveCand, approveAll, dismissCand,
  importText, setImportText, doImport, importResult, setImportResult,
  filterProf, setFilterProf, doSync, syncing, syncMsg, lastSynced,
  keyStatus, setKeyStatus, autoScore, setAutoScore, scoreBusy, scoreMsg, scoreItems }) {
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
  var watchFiltered = applyFilter(watchRaw).slice().sort(sortFn);
  var staleW = watchFiltered.filter(function (l) { return daysSince(l.lastChecked) >= STALE_DAYS; });
  var freshW = watchFiltered.filter(function (l) { return daysSince(l.lastChecked) < STALE_DAYS; });
  var rejL = applyFilter(data.listings.filter(function (l) { return l.status === "rejected"; })).slice().sort(sortFn);
  var purchL = applyFilter(data.listings.filter(function (l) { return l.status === "purchased"; })).slice().sort(sortFn);

  var activeProfiles = data.profiles.filter(function (p) { return p.active; });

  var [showRej, setShowRej] = useState(false);

  function cp(l, stale) {
    return { key: l.id, listing: l, data: data, editing: edListing === l.id,
      onEdit: function () { setEdListing(edListing === l.id ? null : l.id); },
      onUpd: function (u) { updListing(l.id, u); setEdListing(null); },
      onStatus: function (s) { updListing(l.id, { status: s }); },
      onDel: function () { delListing(l.id); },
      onChk: function () { markChk(l.id); }, stale: stale,
      onScore: function () { scoreItems([], [l]); }, scoreBusy: scoreBusy, keyOk: keyStatus.valid };
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
        scoreBusy={scoreBusy} scoreMsg={scoreMsg} />

      {/* Filter & Sort bar */}
      {totalAll > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <select style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 8px", fontSize: 12 })} value={filterProf} onChange={function (e) { setFilterProf(e.target.value); }}>
            <option value="all">All profiles</option>
            {activeProfiles.map(function (p) { return (<option key={p.id} value={p.id}>{p.name}</option>); })}
          </select>
          <select style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 8px", fontSize: 12 })} value={filterRole} onChange={function (e) { setFilterRole(e.target.value); }}>
            <option value="all">All roles</option>
            <option value="SUV">SUV only</option>
            <option value="Commuter">Commuter only</option>
          </select>
          <select style={Object.assign({}, S.inp, { flex: "0 0 auto", padding: "5px 8px", fontSize: 12 })} value={sortBy} onChange={function (e) { setSortBy(e.target.value); }}>
            <option value="score">Sort: Score ↓</option>
            <option value="price">Sort: Price ↑</option>
            <option value="priceDesc">Sort: Price ↓</option>
            <option value="mileage">Sort: Mileage ↑</option>
            <option value="mileageDesc">Sort: Mileage ↓</option>
          </select>
          {(filterProf !== "all" || filterRole !== "all") && (
            <span style={{ fontSize: 11, color: "#6b6b76" }}>{totalShown} of {totalAll}</span>
          )}
        </div>
      )}

      {/* Import candidates */}
      {candidates.length > 0 && (
        <div style={S.card}>
          <div style={S.secH}>
            <h3 style={S.cardH}>Candidates ({candidates.length})</h3>
            <div style={{ display: "flex", gap: 6 }}>
              {keyStatus.valid && (
                <button style={Object.assign({}, S.secBtn, scoreBusy ? { opacity: 0.6 } : {})} disabled={scoreBusy}
                  onClick={function () { scoreItems(candidates, []); }}>{scoreBusy ? "Scoring…" : "✨ Score all"}</button>
              )}
              {candidates.length > 1 && (<button style={S.priBtn} onClick={approveAll}>Approve All</button>)}
            </div>
          </div>
          {candidates.map(function (c, i) {
            return (<CandCard key={i} cand={c} onApprove={function () { approveCand(c); }} onDismiss={function () { dismissCand(c); }} data={data}
              onScore={function () { scoreItems([c], []); }} scoreBusy={scoreBusy} keyOk={keyStatus.valid} />);
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
function AiPanel({ keyStatus, setKeyStatus, autoScore, setAutoScore, scoreBusy, scoreMsg }) {
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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

function Thumb({ photo, link, alt }) {
  if (!photo) return null;
  var href = link || photo;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginBottom: 8 }}>
      <img src={photo} alt={alt || ""} loading="lazy"
        onError={function (e) { e.target.style.display = "none"; }}
        style={{ width: "100%", maxHeight: 180, objectFit: "cover", borderRadius: 8, border: "1px solid #1e2028", display: "block" }} />
    </a>
  );
}

function CandCard({ cand, onApprove, onDismiss, data, onScore, scoreBusy, keyOk }) {
  var prof = data.profiles.find(function (p) { return p.id === cand.profileId; });
  var scoreColor = cand.compositeScore >= 7 ? "#2d8659" : cand.compositeScore >= 5 ? "#d4a017" : "#c44";
  return (
    <div style={Object.assign({}, S.card, { borderLeft: "3px solid #2563eb", background: "#12141c" })}>
      <Thumb photo={cand.photo} link={cand.link} alt={cand.year + " " + cand.vehicle} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: 14, color: "#f0f0f3" }}>{cand.year} {cand.vehicle}</strong>
          {cand.trim && <span style={S.trimB}>{cand.trim}</span>}
          {prof && <span style={Object.assign({}, S.role, { background: prof.role === "SUV" ? "#1a5c3a" : "#1a3c5c", marginLeft: 6 })}>{prof.role}</span>}
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
      <div style={{ fontSize: 12, color: "#6b9edd", marginBottom: 8 }}>
        Left for {(prof && prof.role === "SUV") ? "commuter" : "SUV"}: <strong>${calcRem(cand.price).toLocaleString()}</strong>
      </div>
      <AiBox listing={cand} criteria={data.criteria} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button style={Object.assign({}, S.priBtn, { padding: "6px 14px", fontSize: 12 })} onClick={onApprove}>✓ Add to Watchlist</button>
        {keyOk && onScore && (
          <button style={Object.assign({}, S.smBtn, { color: "#b89edd" }, scoreBusy ? { opacity: 0.6 } : {})} disabled={scoreBusy}
            onClick={onScore}>{scoreBusy ? "Scoring…" : (cand.scoredAt ? "✨ Re-score" : "✨ Score")}</button>
        )}
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

function LCard({ listing, data, editing, onEdit, onUpd, onStatus, onDel, onChk, stale, onScore, scoreBusy, keyOk }) {
  var l = listing;
  var prof = data.profiles.find(function (p) { return p.id === l.profileId; });
  var profRole = prof ? prof.role : "?";
  var rem = calcRem(l.price || 0);
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
          <span style={Object.assign({}, S.role, { background: profRole === "SUV" ? "#1a5c3a" : profRole === "Commuter" ? "#1a3c5c" : "#444", marginLeft: 6 })}>{profRole}</span>
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
      <div style={{ fontSize: 12, color: "#6b9edd", marginBottom: 4 }}>Left for {profRole === "SUV" ? "commuter" : "SUV"}: <strong>${rem.toLocaleString()}</strong></div>
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
          {keyOk && onScore && <button style={Object.assign({}, S.smBtn, { color: "#b89edd" }, scoreBusy ? { opacity: 0.6 } : {})} disabled={scoreBusy} onClick={onScore}>{scoreBusy ? "Scoring…" : (l.scoredAt ? "✨ Re-score" : "✨ Score")}</button>}
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
  srcB: { fontSize: 10, fontWeight: 600, background: "#1a3c5c", color: "#6b9edd", padding: "2px 6px", borderRadius: 3 },
  hubB: { fontSize: 10, fontWeight: 500, background: "#2a1c3c", color: "#b89edd", padding: "2px 6px", borderRadius: 3 },
  trimB: { fontSize: 11, background: "#1e2028", color: "#8a8a96", padding: "2px 6px", borderRadius: 3, marginLeft: 6 },
  saltW: { fontSize: 12, color: "#d4a017", background: "#2a2210", padding: "6px 10px", borderRadius: 4 },
  budL: { fontSize: 11, color: "#6b6b76", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 },
  budR: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#c8c8d0", padding: "3px 0", flexWrap: "wrap", gap: 4 },
  budRem: { fontSize: 12, color: "#6b9edd" },
  calcR: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  calcL: { fontSize: 12, color: "#8a8a96", width: 90 },
  calcI: { background: "#1a1c22", border: "1px solid #2a2d38", borderRadius: 5, color: "#e4e4e7", padding: "7px 10px", fontSize: 13, flex: 1, fontFamily: "inherit" },
  calcHint: { fontSize: 12, color: "#6b6b76" },
};
