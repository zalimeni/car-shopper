import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import crypto from "node:crypto";

// api/_auth.js authorize(): tokens are verified locally against the project's
// signing keys (JWKS), then my_access() decides. fetch is stubbed: it serves a
// JWKS for a test ES256 key and answers the RPC; nothing leaves the process.

var kid = "test-kid";
var keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
var other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
var access = { allowed: true, admin: false, has_mfa: false };
var mfaRpcMissing = false; // the deploy landed before the migration
var calls = [];
var jwksFetches = 0; // never reset: counts across the whole file

function b64(o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function sign(claims, key) {
  var head = b64({ alg: "ES256", typ: "JWT", kid: kid }) + "." + b64(claims);
  var sig = crypto.sign("sha256", Buffer.from(head), { key: (key || keys).privateKey, dsaEncoding: "ieee-p1363" });
  return head + "." + sig.toString("base64url");
}
function claims(extra) {
  var now = Math.floor(Date.now() / 1000);
  return Object.assign({ sub: "11111111-1111-1111-1111-111111111111", email: "me@example.com", role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, is_anonymous: false }, extra || {});
}
function req(token) { return { headers: token ? { authorization: "Bearer " + token } : {} }; }

var authorize;
beforeAll(async () => {
  var jwk = Object.assign(keys.publicKey.export({ format: "jwk" }), { kid: kid, alg: "ES256", use: "sig", key_ops: ["verify"] });
  vi.stubGlobal("fetch", async (url, init) => {
    url = String(url);
    calls.push(url);
    if (url.indexOf("jwks.json") > -1) jwksFetches++;
    if (url.indexOf("/auth/v1/.well-known/jwks.json") > -1) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.indexOf("/rest/v1/rpc/my_access_mfa") > -1 && mfaRpcMissing) return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function public.my_access_mfa" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (url.indexOf("/rest/v1/rpc/my_access_mfa") > -1) return new Response(JSON.stringify([access]), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.indexOf("/rest/v1/rpc/my_access") > -1) return new Response(JSON.stringify([{ allowed: access.allowed, admin: access.admin }]), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.indexOf("/auth/v1/user") > -1) throw new Error("getUser must not be called");
    return new Response("{}", { status: 404 });
  });
  var mod = await import("../api/_auth.js");
  authorize = mod.authorize;
  requireAdmin = mod.requireAdmin;
});
var requireAdmin;
beforeEach(() => { access = { allowed: true, admin: false, has_mfa: false }; mfaRpcMissing = false; calls = []; });

describe("authorize", () => {
  it("accepts a valid token on the allowlist, without calling the Auth server", async () => {
    var r = await authorize(req(sign(claims())));
    expect(r).toEqual({ user: { id: "11111111-1111-1111-1111-111111111111", email: "me@example.com" }, admin: false, mfa: { enrolled: false, aal: "aal1" } });
    expect(calls.some((u) => u.indexOf("/auth/v1/user") > -1)).toBe(false);
  });
  it("reports admins", async () => {
    access = { allowed: true, admin: true };
    expect((await authorize(req(sign(claims())))).admin).toBe(true);
  });
  it("fetches the signing keys once, then reuses them", async () => {
    await authorize(req(sign(claims())));
    await authorize(req(sign(claims())));
    expect(jwksFetches).toBe(1);
  });
  it("403s a valid token that is not on the allowlist", async () => {
    access = { allowed: false, admin: false, has_mfa: false };
    expect((await authorize(req(sign(claims())))).status).toBe(403);
  });
  it("401s a missing, expired, forged, anonymous or non-user token", async () => {
    var past = Math.floor(Date.now() / 1000) - 7200;
    expect((await authorize(req(""))).status).toBe(401);
    expect((await authorize(req("not-a-jwt"))).status).toBe(401);
    expect((await authorize(req(sign(claims({ iat: past - 3600, exp: past }))))).status).toBe(401);
    expect((await authorize(req(sign(claims(), other)))).status).toBe(401);
    expect((await authorize(req(sign(claims({ is_anonymous: true }))))).status).toBe(401);
    expect((await authorize(req(sign(claims({ role: "anon" }))))).status).toBe(401);
  });
});

describe("authorize: two-factor", () => {
  it("401s an aal1 token once the user has a verified factor, with code mfa_required", async () => {
    access = { allowed: true, admin: false, has_mfa: true };
    var r = await authorize(req(sign(claims({ aal: "aal1" }))));
    expect(r).toMatchObject({ status: 401, code: "mfa_required" });
    expect((await authorize(req(sign(claims())))).code).toBe("mfa_required"); // no aal claim = aal1
  });
  it("accepts the same user's aal2 token", async () => {
    access = { allowed: true, admin: false, has_mfa: true };
    var r = await authorize(req(sign(claims({ aal: "aal2" }))));
    expect(r.error).toBeUndefined();
    expect(r.mfa).toEqual({ enrolled: true, aal: "aal2" });
  });
  it("leaves a user with no factor alone at aal1 (opt-in)", async () => {
    expect((await authorize(req(sign(claims({ aal: "aal1" }))))).error).toBeUndefined();
  });
  it("not on the list is still 403, MFA or not", async () => {
    access = { allowed: false, admin: false, has_mfa: true };
    expect((await authorize(req(sign(claims({ aal: "aal2" }))))).status).toBe(403);
  });
  it("falls back to my_access() while the migration hasn't landed", async () => {
    mfaRpcMissing = true;
    access = { allowed: true, admin: true, has_mfa: false };
    var r = await authorize(req(sign(claims())));
    expect(r).toMatchObject({ admin: true, mfa: { enrolled: false, aal: "aal1" } });
    expect(calls.some((u) => /rpc\/my_access$/.test(u))).toBe(true);
  });
  it("requireAdmin: admins need aal2 even before enrolling", async () => {
    expect(requireAdmin({ admin: false, mfa: { enrolled: true, aal: "aal2" } })).toMatchObject({ status: 403, error: "Admins only" });
    expect(requireAdmin({ admin: true, mfa: { enrolled: false, aal: "aal1" } })).toMatchObject({ status: 403, code: "mfa_enroll_required" });
    expect(requireAdmin({ admin: true, mfa: { enrolled: true, aal: "aal2" } })).toBe(null);
  });
});
