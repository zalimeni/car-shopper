import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// A tiny in-memory stand-in for the service-role client: enough of
// .from("user_api_keys").select/insert/update/delete + .eq/.not/.order/.limit.
const db = vi.hoisted(() => {
  const state = { rows: [], nextId: 1 };
  function q(table) {
    let op = "select", patch = null, filters = [];
    const self = {
      select() { return self; }, order() { return self; }, limit() { return self; },
      eq(k, v) { filters.push((r) => r[k] === v); return self; },
      not(k, _op, pat) { const pre = pat.replace("%", ""); filters.push((r) => String(r[k]).indexOf(pre) !== 0); return self; },
      update(p) { op = "update"; patch = p; return self; },
      delete() { op = "delete"; return self; },
      insert(rows) { [].concat(rows).forEach((r) => state.rows.push(Object.assign({ id: state.nextId++, valid: true, label: "", position: 0 }, r))); return Promise.resolve({ error: null }); },
      then(resolve) {
        const hit = state.rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") hit.forEach((r) => Object.assign(r, patch));
        if (op === "delete") state.rows = state.rows.filter((r) => hit.indexOf(r) < 0);
        return resolve({ data: op === "select" ? hit.map((r) => Object.assign({}, r)) : null, error: null });
      },
    };
    return self;
  }
  return { state, client: { from: q } };
});
vi.mock("../api/_supabaseAdmin.js", () => ({ adminClient: () => db.client }));

beforeAll(() => { process.env.KEY_ENCRYPTION_SECRET = "test-secret-at-least-16-chars-long"; });
const { getAnthropicKey, getMarketcheckKeys, addMarketcheckKeys, keyMeta, looksLikeMarketcheckKey } = await import("../api/_keys.js");
const { encrypt } = await import("../api/_crypto.js");

const U = "00000000-0000-0000-0000-0000000000a1";
beforeEach(() => { db.state.rows = []; db.state.nextId = 1; });

describe("key vault", () => {
  it("reads the Anthropic key bound to its owner", async () => {
    db.state.rows.push({ id: 1, user_id: U, provider: "anthropic", position: 0, ciphertext: encrypt("sk-ant-mine", U + ":anthropic"), last4: "mine", valid: true });
    expect(await getAnthropicKey(U)).toEqual({ key: "sk-ant-mine" });
  });
  it("a ciphertext moved to another user's row doesn't decrypt there", async () => {
    db.state.rows.push({ id: 1, user_id: "someone-else", provider: "anthropic", position: 0, ciphertext: encrypt("sk-ant-x", U + ":anthropic"), last4: "", valid: true });
    expect((await getAnthropicKey("someone-else")).error).toBe("key_unreadable");
    expect(db.state.rows[0].valid).toBe(false);
  });
  it("adds MarketCheck keys in order, skips ones already stored, and lists only metadata", async () => {
    await addMarketcheckKeys(U, [{ key: "AAAA0000AAAA1111", label: "one" }, { key: "BBBB0000BBBB2222" }]);
    await addMarketcheckKeys(U, [{ key: "AAAA0000AAAA1111" }, { key: "CCCC0000CCCC3333" }]);
    expect(await getMarketcheckKeys(U)).toEqual(["AAAA0000AAAA1111", "BBBB0000BBBB2222", "CCCC0000CCCC3333"]);
    const meta = await keyMeta(U);
    expect(meta.marketcheck.map((k) => [k.label, k.last4])).toEqual([["one", "1111"], ["", "2222"], ["", "3333"]]);
    expect(JSON.stringify(meta)).not.toContain("AAAA0000");
  });
  it("skips (and flags invalid) a MarketCheck key that can't be decrypted", async () => {
    db.state.rows.push({ id: 1, user_id: U, provider: "marketcheck", position: 0, ciphertext: "not-v2", valid: true });
    db.state.rows.push({ id: 2, user_id: U, provider: "marketcheck", position: 1, ciphertext: encrypt("MCKEY0000000001", U + ":marketcheck"), valid: true });
    expect(await getMarketcheckKeys(U)).toEqual(["MCKEY0000000001"]);
    expect(db.state.rows[0].valid).toBe(false);
  });
  it("looksLikeMarketcheckKey", () => {
    expect(looksLikeMarketcheckKey("abcDEF1234567890")).toBe(true);
    expect(looksLikeMarketcheckKey("short")).toBe(false);
    expect(looksLikeMarketcheckKey("has spaces in it 123")).toBe(false);
  });
});
