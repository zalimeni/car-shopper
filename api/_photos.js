// Stored listing photos, server side (see src/photoKey.js for the pure parts).
//
//   storePhotos(db, userId, items) — copy dealer photos into the private
//     `listing-photos` bucket at <user_id>/<VIN>.<ext> (POST /api/snapshots
//     { photos }). The browser can't fetch them (CORS), so the server does,
//     behind an SSRF guard: http(s) only, default ports, no credentials in the
//     URL, every resolved address must be public (checked at connect time by
//     the socket's own DNS lookup, so a rebinding answer can't slip in after
//     the check), at most 3 redirects (each hop checked the same way), a size
//     cap, a short timeout, and the bytes must sniff as JPEG / PNG / WebP /
//     GIF / AVIF. Stored as-is (image transformations are a paid feature).
//   sweepOrphanPhotos(db) — the daily cleanup (api/cron-sync.js): objects no
//     blob references any more, and whole folders of users with no app_state
//     row. Storage objects don't cascade when a user is deleted, and SQL
//     deletes on storage.objects are blocked, so this goes through the Storage
//     API with the service role.
//
// Writes and the sweep use the service-role client; users read their own
// folder through RLS (signed URLs, src/photos.js) and delete their own
// objects when they delete a listing.

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { PHOTO_BUCKET, PHOTO_MAX_BYTES, PHOTO_BATCH, photoKeyFor, photoVin, referencedPhotoKeys } from "../src/photoKey.js";

export const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

// ── Address guard ──

function v4ToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(function (r) { return [v4ToInt(r[0]), r[1]]; });

function v4Blocked(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(function (r) {
    const mask = r[1] === 0 ? 0 : (0xffffffff << (32 - r[1])) >>> 0;
    return ((n & mask) >>> 0) === ((r[0] & mask) >>> 0);
  });
}

// Expand an IPv6 address into 8 16-bit groups (handles "::" and a dotted tail).
function v6Groups(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const dot = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dot) {
    const n = v4ToInt(dot[1]);
    s = s.slice(0, -dot[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const all = head.concat(new Array(Math.max(0, fill)).fill("0"), tail);
  return all.length === 8 ? all.map(function (g) { return parseInt(g, 16) || 0; }) : null;
}

// True for any address a server-side fetch must not reach: private, loopback,
// link-local, CGNAT, multicast, reserved, documentation, unspecified — and the
// IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4) when it is one.
export function isPrivateAddress(ip) {
  const fam = net.isIP(String(ip || ""));
  if (fam === 4) return v4Blocked(ip);
  if (fam !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  const embedded = function (hi, lo) { return [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join("."); };
  if (g.slice(0, 7).every(function (x) { return x === 0; })) return true; // :: and ::1
  if (g.slice(0, 5).every(function (x) { return x === 0; }) && (g[5] === 0xffff || g[5] === 0)) return v4Blocked(embedded(g[6], g[7])); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Blocked(embedded(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF special (Teredo etc.)
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  return false;
}

// Parse + vet a photo URL before any network use. Returns { url } or { error }.
export function checkPhotoUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { return { error: "not a URL" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "only http(s) photos" };
  if (u.username || u.password) return { error: "credentials in URL" };
  if (u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))) return { error: "non-standard port" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { error: "no host" };
  if (net.isIP(host)) { if (isPrivateAddress(host)) return { error: "blocked address" }; }
  else if (!/\./.test(host) || /\.(localhost|local|internal|localdomain|home\.arpa)$/i.test(host) || /^localhost$/i.test(host)) return { error: "blocked host" };
  return { url: u };
}

// A dns.lookup-compatible function that refuses private answers. The socket
// calls it when connecting, so the address checked is the address used.
export function guardedLookup(resolve) {
  const res = resolve || dns.lookup;
  return function (hostname, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    res(hostname, Object.assign({}, options, { all: true }), function (err, addrs) {
      if (err) { cb(err); return; }
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length || list.some(function (a) { return isPrivateAddress(a.address); })) {
        const e = new Error("blocked address"); e.code = "EBLOCKED"; cb(e); return;
      }
      if (options && options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}

// What the bytes are (magic numbers), or "" — the content-type header alone
// isn't trusted.
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(buf.toString("latin1", 8, 12))) return "image/avif";
  return "";
}

class PhotoError extends Error {
  constructor(msg, permanent) { super(msg); this.permanent = !!permanent; }
}

// One GET, no redirect following. Resolves { status, headers, location, body }.
function getOnce(u, opts, deadline) {
  return new Promise(function (resolve, reject) {
    const mod = u.protocol === "https:" ? https : http;
    const left = deadline - Date.now();
    if (left <= 0) { reject(new PhotoError("timed out")); return; }
    const req = mod.get(u, {
      lookup: opts.lookup || guardedLookup(),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; listing-photo-copy)", Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      timeout: left,
      agent: opts.agent, // tests only (dial a local server); default: the global agent
    }, function (res) {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) { res.resume(); resolve({ status: status, location: res.headers.location || "" }); return; }
      if (status !== 200) { res.resume(); reject(new PhotoError("HTTP " + status, status === 404 || status === 410 || status === 403 || status === 401)); return; }
      const ct = String(res.headers["content-type"] || "").toLowerCase();
      if (ct && ct.indexOf("image/") !== 0 && ct.indexOf("application/octet-stream") !== 0) { res.resume(); reject(new PhotoError("not an image (" + ct.split(";")[0] + ")", true)); return; }
      const len = Number(res.headers["content-length"] || 0);
      if (len > PHOTO_MAX_BYTES) { res.destroy(); reject(new PhotoError("too large", true)); return; }
      const chunks = []; let size = 0;
      res.on("data", function (c) {
        size += c.length;
        if (size > PHOTO_MAX_BYTES) { res.destroy(); reject(new PhotoError("too large", true)); return; }
        chunks.push(c);
      });
      res.on("end", function () { resolve({ status: 200, body: Buffer.concat(chunks) }); });
      res.on("error", reject);
    });
    req.on("timeout", function () { req.destroy(new PhotoError("timed out")); });
    req.on("error", function (e) { reject(e instanceof PhotoError ? e : new PhotoError(e && e.code === "EBLOCKED" ? "blocked address" : ((e && e.message) || "fetch failed"), e && (e.code === "EBLOCKED" || e.code === "ENOTFOUND"))); });
  });
}

// Fetch a photo behind the guard. Resolves { body, mime } or throws a
// PhotoError (`.permanent` when retrying can't help).
export async function fetchImage(raw, opts) {
  const o = opts || {};
  const deadline = Date.now() + (o.timeoutMs || FETCH_TIMEOUT_MS);
  let cur = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const chk = checkPhotoUrl(cur);
    if (chk.error) throw new PhotoError(chk.error, true);
    const r = await (o.get || getOnce)(chk.url, o, deadline);
    if (r.status === 200) {
      const mime = sniffImage(r.body);
      if (!mime) throw new PhotoError("not an image", true);
      return { body: r.body, mime: mime };
    }
    if (!r.location) throw new PhotoError("redirect without a location", true);
    cur = new URL(r.location, chk.url).toString();
  }
  throw new PhotoError("too many redirects", true);
}

// Copy up to PHOTO_BATCH photos for one user. items: [{ vin, url }].
// Returns { stored: [{ vin, key }], failed: [{ vin, url, error, permanent }] }.
export async function storePhotos(db, userId, items, opts) {
  const out = { stored: [], failed: [] };
  const list = (Array.isArray(items) ? items : []).slice(0, PHOTO_BATCH);
  await Promise.all(list.map(async function (it) {
    const vin = photoVin(it && it.vin);
    const url = String((it && it.url) || "");
    if (!vin) { out.failed.push({ vin: String((it && it.vin) || ""), url: url, error: "bad VIN", permanent: true }); return; }
    try {
      const img = await fetchImage(url, opts);
      const key = photoKeyFor(userId, vin, img.mime);
      if (!key) throw new PhotoError("bad path", true);
      const up = await db.storage.from(PHOTO_BUCKET).upload(key, img.body, { contentType: img.mime, upsert: true, cacheControl: "31536000" });
      if (up.error) throw new PhotoError("upload: " + up.error.message);
      out.stored.push({ vin: vin, key: key });
    } catch (e) {
      out.failed.push({ vin: vin, url: url, error: (e && e.message) || "failed", permanent: !!(e && e.permanent) });
    }
  }));
  return out;
}

// ── Orphan sweep ──

export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000; // a copy whose blob save hasn't landed yet is safe
export const SWEEP_MAX_USERS = 40;
export const SWEEP_MAX_DELETES = 300;
export const SWEEP_BUDGET_MS = 6000; // checked between folders; the cron's sync then gets its own 50 s (maxDuration 60)

async function listAll(bucket, prefix, max) {
  const out = [];
  for (let offset = 0; offset < max; offset += 100) {
    const r = await bucket.list(prefix, { limit: 100, offset: offset, sortBy: { column: "name", order: "asc" } });
    if (r.error) throw new Error("list " + (prefix || "/") + ": " + r.error.message);
    const rows = r.data || [];
    rows.forEach(function (x) { out.push(x); });
    if (rows.length < 100) break;
  }
  return out;
}

function oldEnough(obj, now) {
  const t = Date.parse((obj && (obj.updated_at || obj.created_at)) || "");
  return !isNaN(t) && now - t > SWEEP_GRACE_MS;
}

// Delete the objects nothing references any more. A folder whose user has an
// app_state row keeps exactly the photoKeys that blob references (listings,
// the review queue, skipped cars — src/photoKey.js referencedPhotoKeys); a
// folder whose user has no app_state row (the user was deleted — app_state
// cascades from auth.users, storage doesn't — or never saved anything) goes
// entirely. Being dropped from allowed_emails is NOT a reason: the blob
// outlives that too, and re-adding someone should bring their photos back.
// Only objects older than the grace period are deleted. Capped per run.
export async function sweepOrphanPhotos(db, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const deadline = Date.now() + (o.budgetMs || SWEEP_BUDGET_MS);
  const maxDeletes = o.maxDeletes || SWEEP_MAX_DELETES;
  const res = { folders: 0, checked: 0, deleted: 0, kept: 0, errors: [] };
  const bucket = db.storage.from(PHOTO_BUCKET);
  let folders;
  try { folders = await listAll(bucket, "", 1000); } catch (e) { res.errors.push(e.message); return res; }
  // Folders have no id; anything else at the top level is stray.
  const users = folders.filter(function (f) { return f && !f.id && /^[0-9a-f-]{36}$/.test(f.name); }).map(function (f) { return f.name; });
  // Start at a different folder each day, so a cap never starves the same ones.
  const start = users.length ? Math.floor(now / 86400000) % users.length : 0;
  const order = users.slice(start).concat(users.slice(0, start)).slice(0, o.maxUsers || SWEEP_MAX_USERS);
  for (const uid of order) {
    if (res.deleted >= maxDeletes || Date.now() > deadline) break;
    res.folders++;
    try {
      const row = await db.from("app_state").select("data").eq("user_id", uid).maybeSingle();
      if (row.error) throw new Error("app_state: " + row.error.message);
      const keep = row.data ? referencedPhotoKeys(row.data.data) : {};
      const objs = (await listAll(bucket, uid, 2000)).filter(function (x) { return x && x.id; });
      res.checked += objs.length;
      const doomed = objs.filter(function (x) { return !keep[uid + "/" + x.name] && oldEnough(x, now); })
        .map(function (x) { return uid + "/" + x.name; })
        .slice(0, maxDeletes - res.deleted);
      res.kept += objs.length - doomed.length;
      for (let i = 0; i < doomed.length; i += 100) {
        const del = await bucket.remove(doomed.slice(i, i + 100));
        if (del.error) throw new Error("remove: " + del.error.message);
        res.deleted += (del.data || []).length;
      }
    } catch (e) {
      res.errors.push(uid.slice(0, 8) + ": " + ((e && e.message) || "failed"));
    }
  }
  if (users.length > res.folders) res.more = true;
  return res;
}
