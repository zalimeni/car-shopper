// Stored listing photos: the pure parts, shared by the browser (src/photos.js,
// App.jsx) and the server (api/_photos.js). Import-free.
//
// A watchlist car's dealer photo (`listing.photo`, a hotlinked URL) dies when
// the car sells or is relisted. The server copies it into the private Supabase
// Storage bucket `listing-photos` at `<user_id>/<VIN>.<ext>` and the listing
// keeps that path as `listing.photoKey`. `photoFailed` holds a dealer URL that
// can't be copied (dead, not an image, blocked), so it isn't retried.

export var PHOTO_BUCKET = "listing-photos";
export var PHOTO_MAX_BYTES = 2 * 1024 * 1024; // = the bucket's file_size_limit
export var PHOTO_BATCH = 6;                   // photos per copy request
export var PHOTO_EXTS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var VIN_RE = /^[A-Z0-9]{5,17}$/;
var KEY_RE = /^([0-9a-f-]{36})\/([A-Z0-9]{5,17})\.(jpg|png|webp|gif|avif)$/;

// A VIN as used in a path (upper case, letters and digits only), or "".
export function photoVin(vin) {
  var v = String(vin || "").trim().toUpperCase();
  return VIN_RE.test(v) ? v : "";
}

// The object path for a user's copy of a car's photo, or "" if any part is bad.
export function photoKeyFor(uid, vin, mime) {
  var v = photoVin(vin), ext = PHOTO_EXTS[mime];
  if (!UUID_RE.test(String(uid || "")) || !v || !ext) return "";
  return String(uid).toLowerCase() + "/" + v + "." + ext;
}

// Is `key` a well-formed photo path in `uid`'s own folder (and for `vin`, when
// given)? Import validation keeps a photoKey only when this holds.
export function isPhotoKey(key, uid, vin) {
  var m = KEY_RE.exec(String(key || ""));
  if (!m || !uid || m[1] !== String(uid).toLowerCase()) return false;
  return vin == null || m[2] === photoVin(vin);
}

// The user folder a stored key lives in ("" if malformed).
export function photoKeyOwner(key) {
  var m = KEY_RE.exec(String(key || ""));
  return m ? m[1] : "";
}

function httpUrl(u) { return /^https?:\/\//i.test(String(u || "").trim()); }

// Listings whose photo should be copied (or copied again): not rejected, a
// dealer http(s) photo and a VIN, and no stored copy — or one known missing
// (`missing[key]`, e.g. a backup restore brought back a listing whose object
// was swept). Skips photos that already failed for good. Newest first.
export function photoTodo(listings, missing, max) {
  var gone = missing || {};
  var out = [];
  var list = (listings || []).slice().reverse();
  for (var i = 0; i < list.length && out.length < (max || PHOTO_BATCH); i++) {
    var l = list[i];
    if (!l || l.status === "rejected" || !httpUrl(l.photo) || !photoVin(l.vin)) continue;
    if (l.photoFailed && l.photoFailed === l.photo) continue;
    if (l.photoKey && !gone[l.photoKey]) continue;
    out.push(l);
  }
  return out;
}

// Fold a copy result ({ stored: [{ vin, key }], failed: [{ vin, url, permanent }] })
// into listings: stored → photoKey; a permanent failure → photoFailed (and a
// photoKey known missing is dropped, so Thumb stops asking for it).
// Returns the same array when nothing changed.
export function applyPhotoResults(listings, result, missing) {
  var got = {}, bad = {}, gone = missing || {};
  ((result && result.stored) || []).forEach(function (s) { var v = photoVin(s && s.vin); if (v && s.key) got[v] = s.key; });
  ((result && result.failed) || []).forEach(function (f) { var v = photoVin(f && f.vin); if (v && f.permanent) bad[v] = f.url || true; });
  var changed = false;
  var next = (listings || []).map(function (l) {
    var v = l && photoVin(l.vin);
    if (!v) return l;
    if (got[v] && isPhotoKey(got[v], photoKeyOwner(got[v]), v) && l.photoKey !== got[v]) {
      changed = true;
      var o = Object.assign({}, l, { photoKey: got[v] });
      delete o.photoFailed;
      return o;
    }
    if (bad[v] && (bad[v] === true || bad[v] === l.photo) && (!l.photoKey || gone[l.photoKey])) {
      changed = true;
      var b = Object.assign({}, l, { photoFailed: l.photo || "" });
      delete b.photoKey;
      return b;
    }
    return l;
  });
  return changed ? next : listings;
}

// Every photoKey an app-state blob still references (listings, the review
// queue, skipped cars) — the orphan sweep keeps exactly these.
export function referencedPhotoKeys(data) {
  var keys = {};
  var d = data || {};
  [d.listings, d.candidates, d.pendingCandidates, d.skipped].forEach(function (arr) {
    (Array.isArray(arr) ? arr : []).forEach(function (l) { if (l && typeof l.photoKey === "string" && l.photoKey) keys[l.photoKey] = true; });
  });
  return keys;
}
