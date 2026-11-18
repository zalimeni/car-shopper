import { describe, it, expect } from "vitest";
import { photoKeyFor, isPhotoKey, photoVin, photoTodo, applyPhotoResults, referencedPhotoKeys, PHOTO_BATCH, PHOTO_MAX_BYTES } from "../src/photoKey.js";
import { isPrivateAddress, checkPhotoUrl, guardedLookup, sniffImage, fetchImage, storePhotos, sweepOrphanPhotos, SWEEP_GRACE_MS } from "../api/_photos.js";
import { parseImport } from "../src/App.jsx";

const UID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const VIN = "1HGCM82633A004352";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);

describe("photo keys", () => {
  it("builds <uid>/<VIN>.<ext> and rejects bad parts", () => {
    expect(photoKeyFor(UID, VIN.toLowerCase(), "image/jpeg")).toBe(UID + "/" + VIN + ".jpg");
    expect(photoKeyFor(UID, VIN, "image/webp")).toBe(UID + "/" + VIN + ".webp");
    expect(photoKeyFor(UID, VIN, "image/svg+xml")).toBe("");
    expect(photoKeyFor("not-a-uid", VIN, "image/jpeg")).toBe("");
    expect(photoKeyFor(UID, "../etc", "image/jpeg")).toBe("");
    expect(photoVin(" abc/12 ")).toBe("");
  });
  it("isPhotoKey: own folder, matching VIN, known extension only", () => {
    const k = UID + "/" + VIN + ".jpg";
    expect(isPhotoKey(k, UID, VIN)).toBe(true);
    expect(isPhotoKey(k, UID)).toBe(true);
    expect(isPhotoKey(k, OTHER, VIN)).toBe(false);
    expect(isPhotoKey(k, UID, "2T3RWRFV5LW000001")).toBe(false);
    expect(isPhotoKey(UID + "/" + VIN + ".svg", UID, VIN)).toBe(false);
    expect(isPhotoKey(UID + "/../" + VIN + ".jpg", UID)).toBe(false);
    expect(isPhotoKey(k, null, VIN)).toBe(false);
    expect(isPhotoKey("", UID)).toBe(false);
  });
  it("import keeps a photoKey only in the importer's own folder", () => {
    const row = (x) => Object.assign({ vehicle: "Civic", year: 2020, price: 20000, profileId: "p1", vin: VIN, photo: "https://x.example/a.jpg" }, x);
    const k = UID + "/" + VIN + ".jpg";
    expect(parseImport(JSON.stringify([row({ photoKey: k })]), ["p1"], UID).listings[0].photoKey).toBe(k);
    expect(parseImport(JSON.stringify([row({ photoKey: k })]), ["p1"], OTHER).listings[0].photoKey).toBeUndefined();
    expect(parseImport(JSON.stringify([row({ photoKey: k })]), ["p1"]).listings[0].photoKey).toBeUndefined();
    expect(parseImport(JSON.stringify([row({ photoKey: OTHER + "/" + VIN + ".jpg" })]), ["p1"], UID).listings[0].photoKey).toBeUndefined();
  });
});

describe("photoTodo / applyPhotoResults", () => {
  const car = (vin, x) => Object.assign({ vin: vin, status: "watch", photo: "https://d.example/" + vin + ".jpg" }, x);
  it("picks listings with a dealer photo and no (live) stored copy, newest first, capped", () => {
    const k = UID + "/AAAAA1.jpg";
    const list = [car("AAAAA1", { photoKey: k }), car("AAAAA2"), car("AAAAA3", { status: "rejected" }), car("AAAAA4", { photo: "/demo/x.webp" }),
      car("AAAAA5", { photoFailed: "https://d.example/AAAAA5.jpg" }), car("AAAAA6", { photoFailed: "https://old.example/x.jpg" }), car(""), car("AAAAA7", { status: "sold", goneAt: "2026-01-01" })];
    expect(photoTodo(list).map((l) => l.vin)).toEqual(["AAAAA7", "AAAAA6", "AAAAA2"]);
    expect(photoTodo(list, { [k]: true }).map((l) => l.vin)).toEqual(["AAAAA7", "AAAAA6", "AAAAA2", "AAAAA1"]);
    const many = Array.from({ length: 20 }, (_, i) => car("BBBBB" + (10 + i)));
    expect(photoTodo(many).length).toBe(PHOTO_BATCH);
  });
  it("sets photoKey for stored cars and photoFailed for permanent failures", () => {
    const list = [car("AAAAA1"), car("AAAAA2"), car("AAAAA3"), car("AAAAA4", { photoKey: UID + "/AAAAA4.jpg" })];
    const out = applyPhotoResults(list, {
      stored: [{ vin: "aaaaa1", key: UID + "/AAAAA1.jpg" }],
      failed: [{ vin: "AAAAA2", url: "https://d.example/AAAAA2.jpg", permanent: true }, { vin: "AAAAA3", permanent: false }, { vin: "AAAAA4", permanent: true }],
    });
    expect(out[0].photoKey).toBe(UID + "/AAAAA1.jpg");
    expect(out[1].photoFailed).toBe("https://d.example/AAAAA2.jpg");
    expect(out[2]).toBe(list[2]);
    expect(out[3]).toBe(list[3]); // a live copy isn't dropped by a failed re-copy
    // …but a copy known missing is.
    const gone = applyPhotoResults(list, { failed: [{ vin: "AAAAA4", permanent: true }] }, { [UID + "/AAAAA4.jpg"]: true });
    expect(gone[3].photoKey).toBeUndefined();
    expect(applyPhotoResults(list, { stored: [], failed: [] })).toBe(list);
    expect(applyPhotoResults(list, { stored: [{ vin: "AAAAA1", key: "../../x.jpg" }] })).toBe(list);
  });
  it("referencedPhotoKeys reads listings, the queue and skipped cars", () => {
    expect(Object.keys(referencedPhotoKeys({ listings: [{ photoKey: "a" }, {}], candidates: [{ photoKey: "b" }], skipped: [{ photoKey: "c" }] })).sort()).toEqual(["a", "b", "c"]);
    expect(referencedPhotoKeys(null)).toEqual({});
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and reserved addresses", () => {
    ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:db8::1", "not-an-ip"]
      .forEach((ip) => expect(isPrivateAddress(ip), ip).toBe(true));
    ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"].forEach((ip) => expect(isPrivateAddress(ip), ip).toBe(false));
  });
  it("vets URLs before any request", () => {
    expect(checkPhotoUrl("https://img.dealer.example/a.jpg").url).toBeTruthy();
    expect(checkPhotoUrl("http://img.dealer.example/a.jpg").url).toBeTruthy();
    ["ftp://x.example/a", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@x.example/a", "https://x.example:8443/a",
      "http://127.0.0.1/a", "http://[::1]/a", "http://169.254.169.254/latest", "http://localhost/a", "http://intranet/a", "http://foo.internal/a", "nope"]
      .forEach((u) => expect(checkPhotoUrl(u).error, u).toBeTruthy());
  });
  it("guardedLookup refuses any private answer and passes public ones through", async () => {
    const lookup = (addrs) => guardedLookup((h, o, cb) => cb(null, addrs));
    const run = (fn, opts) => new Promise((res) => fn("x.example", opts || {}, (err, a, f) => res({ err, a, f })));
    expect((await run(lookup([{ address: "10.0.0.1", family: 4 }]))).err.code).toBe("EBLOCKED");
    expect((await run(lookup([{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]))).err.code).toBe("EBLOCKED");
    expect(await run(lookup([{ address: "8.8.8.8", family: 4 }]))).toEqual({ err: null, a: "8.8.8.8", f: 4 });
    expect((await run(lookup([{ address: "8.8.8.8", family: 4 }]), { all: true })).a).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
  it("sniffs image bytes", () => {
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1"))).toBe("image/png");
    expect(sniffImage(Buffer.from("RIFF0000WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImage(Buffer.from("GIF89a000000", "latin1"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("0000ftypavif0000", "latin1"))).toBe("image/avif");
    expect(sniffImage(Buffer.from("<html><body>hi</body></html>"))).toBe("");
  });
});

describe("fetchImage", () => {
  it("follows a few redirects, checking every hop", async () => {
    const seen = [];
    const get = async (u) => {
      seen.push(u.href);
      if (u.pathname === "/a") return { status: 301, location: "/b" };
      return { status: 200, body: JPEG };
    };
    expect((await fetchImage("http://cdn.example/a", { get })).mime).toBe("image/jpeg");
    expect(seen).toEqual(["http://cdn.example/a", "http://cdn.example/b"]);
    const toMeta = async () => ({ status: 302, location: "http://169.254.169.254/latest/meta-data" });
    await expect(fetchImage("https://cdn.example/a", { get: toMeta })).rejects.toMatchObject({ permanent: true, message: "blocked address" });
    const loop = async () => ({ status: 302, location: "/again" });
    await expect(fetchImage("https://cdn.example/a", { get: loop })).rejects.toThrow(/too many redirects/);
  });
  it("rejects bytes that aren't an image", async () => {
    const get = async () => ({ status: 200, body: Buffer.from("<html>not a photo</html>") });
    await expect(fetchImage("https://cdn.example/a", { get })).rejects.toMatchObject({ permanent: true });
  });
});

describe("storePhotos", () => {
  it("uploads to the caller's folder and reports failures", async () => {
    const uploads = [];
    const db = { storage: { from: (b) => ({ upload: async (key, body, o) => { uploads.push({ b, key, type: o.contentType, upsert: o.upsert, n: body.length }); return { data: {}, error: null }; } }) } };
    const get = async (u) => (u.pathname === "/ok.jpg" ? { status: 200, body: JPEG } : { status: 200, body: Buffer.from("<html></html>") });
    const r = await storePhotos(db, UID, [{ vin: VIN.toLowerCase(), url: "https://d.example/ok.jpg" }, { vin: "BBBBB2", url: "https://d.example/bad" }, { vin: "../x", url: "https://d.example/ok.jpg" }], { get });
    expect(r.stored).toEqual([{ vin: VIN, key: UID + "/" + VIN + ".jpg" }]);
    expect(uploads).toEqual([{ b: "listing-photos", key: UID + "/" + VIN + ".jpg", type: "image/jpeg", upsert: true, n: JPEG.length }]);
    expect(r.failed.map((f) => f.permanent)).toEqual([true, true]);
    expect(PHOTO_MAX_BYTES).toBe(2097152);
  });
});

describe("sweepOrphanPhotos", () => {
  const NOW = Date.parse("2026-11-18T12:00:00Z");
  const old = new Date(NOW - SWEEP_GRACE_MS - 1000).toISOString();
  const recent = new Date(NOW - 1000).toISOString();
  function fakeDb(folders, states) {
    const removed = [];
    const bucket = {
      list: async (prefix) => {
        if (!prefix) return { data: Object.keys(folders).map((n) => ({ name: n, id: null })).concat([{ name: "stray.jpg", id: "x" }]), error: null };
        return { data: (folders[prefix] || []).map((o) => Object.assign({ id: "id-" + o.name }, o)), error: null };
      },
      remove: async (paths) => { removed.push(...paths); return { data: paths.map((p) => ({ name: p })), error: null }; },
    };
    const db = {
      storage: { from: () => bucket },
      from: () => ({ select: () => ({ eq: (c, uid) => ({ maybeSingle: async () => ({ data: states[uid] === undefined ? null : { data: states[uid] }, error: null }) }) }) }),
    };
    return { db, removed };
  }
  it("deletes unreferenced objects past the grace period and whole folders of users with no state", async () => {
    const { db, removed } = fakeDb({
      [UID]: [{ name: "AAAAA1.jpg", created_at: old }, { name: "AAAAA2.jpg", created_at: old }, { name: "AAAAA3.jpg", created_at: recent }, { name: "AAAAA4.jpg", created_at: old }],
      [OTHER]: [{ name: "CCCCC1.png", created_at: old }, { name: "CCCCC2.png", created_at: recent }],
    }, {
      // A gone car (goneAt) keeps its photo while the listing exists; queue too.
      [UID]: { listings: [{ photoKey: UID + "/AAAAA1.jpg", goneAt: "2026-10-01" }], candidates: [{ photoKey: UID + "/AAAAA4.jpg" }] },
    });
    const r = await sweepOrphanPhotos(db, { now: NOW });
    expect(removed.sort()).toEqual([UID + "/AAAAA2.jpg", OTHER + "/CCCCC1.png"]);
    expect(r).toMatchObject({ folders: 2, checked: 6, deleted: 2, kept: 4, errors: [] });
  });
  it("respects the delete cap", async () => {
    const objs = Array.from({ length: 10 }, (_, i) => ({ name: "DDDDD" + i + ".jpg", created_at: old }));
    const { db, removed } = fakeDb({ [UID]: objs }, {});
    const r = await sweepOrphanPhotos(db, { now: NOW, maxDeletes: 3 });
    expect(removed.length).toBe(3);
    expect(r.deleted).toBe(3);
  });
});

describe("fetchImage over a real socket", () => {
  it("dials through its lookup, caps size, checks type — and the guard refuses loopback", async () => {
    const http = await import("node:http");
    const big = Buffer.concat([JPEG, Buffer.alloc(PHOTO_MAX_BYTES)]);
    const srv = http.createServer((req, res) => {
      if (req.url === "/big.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(big); return; }
      if (req.url === "/page") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html></html>"); return; }
      res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(JPEG);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    // URLs must use port 80, so the test agent dials the server's real port.
    const agent = new http.Agent();
    const dial = agent.createConnection.bind(agent);
    agent.createConnection = (o, cb) => dial(Object.assign({}, o, { port }), cb);
    const toLocal = (h, o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
    const unguarded = (h, o, cb) => { if (o && o.all) cb(null, [{ address: "127.0.0.1", family: 4 }]); else cb(null, "127.0.0.1", 4); };
    const url = (p) => "http://photos.example" + p;
    try {
      expect((await fetchImage(url("/ok.jpg"), { agent, lookup: unguarded })).mime).toBe("image/jpeg");
      await expect(fetchImage(url("/big.jpg"), { agent, lookup: unguarded })).rejects.toThrow(/too large/);
      await expect(fetchImage(url("/page"), { agent, lookup: unguarded })).rejects.toThrow(/not an image/);
      await expect(fetchImage(url("/ok.jpg"), { agent, lookup: guardedLookup(toLocal) })).rejects.toMatchObject({ message: "blocked address", permanent: true });
    } finally { srv.close(); }
  });
});
