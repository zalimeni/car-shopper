// Stored listing photos, browser side (pure parts: src/photoKey.js; server:
// api/_photos.js).
//
//  - useStoredPhoto(key): a signed URL for a stored copy (private bucket, RLS:
//    own folder only). Requests in the same tick are batched into one
//    createSignedUrls call; URLs are cached in memory until shortly before they
//    expire. undefined = still asking, null = none (no key, or the object is
//    missing — remembered in `missing` so the backfill copies it again).
//  - signPhotoKeys(keys): the same, for many keys at once (the backfill's check).
//  - copyPhotos(items): POST /api/snapshots { photos } — the server copies the
//    dealer images. Best-effort: resolves null on any failure.
//  - removePhotos(keys): delete own objects when a listing is deleted.
// None of this runs in the demo (cards just show listing.photo).

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { authHeaders } from "./apiAuth";
import { DEMO } from "./demoRuntime";
import { PHOTO_BUCKET } from "./photoKey.js";

var TTL_S = 3600;
var REFRESH_MS = 5 * 60 * 1000; // re-sign this long before expiry
var cache = {};   // key -> { url, exp }
export var missing = {}; // key -> true: the object isn't there
var waiting = {}; // key -> [resolve]
var timer = null;

function bucket() {
  return supabase && supabase.storage && typeof supabase.storage.from === "function" ? supabase.storage.from(PHOTO_BUCKET) : null;
}

function fresh(key) {
  var c = cache[key];
  return c && c.exp - REFRESH_MS > Date.now() ? c.url : null;
}

function settle(key, url) {
  var list = waiting[key] || [];
  delete waiting[key];
  list.forEach(function (r) { r(url); });
}

async function flush() {
  timer = null;
  var keys = Object.keys(waiting);
  if (!keys.length) return;
  var b = bucket();
  for (var i = 0; i < keys.length; i += 100) {
    var chunk = keys.slice(i, i + 100);
    var r = null;
    try { r = b ? await b.createSignedUrls(chunk, TTL_S) : null; } catch (e) { r = null; }
    var byPath = {};
    ((r && r.data) || []).forEach(function (x) { if (x && x.path) byPath[x.path] = x; });
    chunk.forEach(function (k) {
      var x = byPath[k];
      if (x && x.signedUrl && !x.error) {
        cache[k] = { url: x.signedUrl, exp: Date.now() + TTL_S * 1000 };
        delete missing[k];
        settle(k, x.signedUrl);
      } else {
        // A per-item error with the call itself fine = the object isn't there.
        if (r && !r.error && x && x.error) missing[k] = true;
        settle(k, null);
      }
    });
  }
}

// Promise<signed URL | null> for one key (batched with others asked this tick).
export function signedPhotoUrl(key) {
  if (DEMO || !key) return Promise.resolve(null);
  var hit = fresh(key);
  if (hit) return Promise.resolve(hit);
  if (missing[key]) return Promise.resolve(null);
  return new Promise(function (resolve) {
    (waiting[key] = waiting[key] || []).push(resolve);
    if (!timer) timer = setTimeout(flush, 15);
  });
}

// Sign many keys; resolves { key: url | null }.
export function signPhotoKeys(keys) {
  var out = {};
  return Promise.all((keys || []).map(function (k) {
    return signedPhotoUrl(k).then(function (u) { out[k] = u; });
  })).then(function () { return out; });
}

export function useStoredPhoto(key) {
  var [url, setUrl] = useState(function () { return !key || DEMO ? null : fresh(key) || (missing[key] ? null : undefined); });
  useEffect(function () {
    var live = true;
    if (!key || DEMO) { setUrl(null); return; }
    var hit = fresh(key);
    if (hit) { setUrl(hit); return; }
    signedPhotoUrl(key).then(function (u) { if (live) setUrl(u); });
    return function () { live = false; };
  }, [key]);
  return url;
}

// The signed-in user's id (for import validation of photoKey), or null.
export async function currentUid() {
  try {
    var r = await supabase.auth.getSession();
    var s = r && r.data && r.data.session;
    return s && s.user ? s.user.id : null;
  } catch (e) { return null; }
}

// Ask the server to copy dealer photos. items: [{ vin, url }].
export async function copyPhotos(items) {
  if (DEMO || !items || !items.length) return null;
  try {
    var h = await authHeaders();
    if (!h.Authorization) return null;
    var res = await fetch("/api/snapshots", { method: "POST", headers: h, body: JSON.stringify({ photos: items }) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

// Delete stored copies (own folder only — RLS). Best-effort.
export async function removePhotos(keys) {
  var list = (keys || []).filter(Boolean);
  var b = bucket();
  if (DEMO || !list.length || !b) return;
  list.forEach(function (k) { delete cache[k]; });
  try { await b.remove(list); } catch (e) { /* the daily sweep catches what this misses */ }
}
