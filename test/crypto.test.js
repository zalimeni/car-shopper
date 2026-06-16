import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => { process.env.KEY_ENCRYPTION_SECRET = "test-secret-at-least-16-chars-long"; });

// Import after the env var is set (the module reads it lazily per call, so order
// doesn't strictly matter, but this keeps intent clear).
const { encrypt, decrypt, cryptoReady } = await import("../api/_crypto.js");

describe("_crypto", () => {
  it("round-trips a value", () => {
    const secret = "sk-ant-api03-abc123def456";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("fails to decrypt tampered ciphertext", () => {
    const blob = encrypt("sk-ant-secret");
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("cryptoReady reflects the configured secret", () => {
    expect(cryptoReady()).toBe(true);
  });
});
