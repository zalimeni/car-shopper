import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => { process.env.KEY_ENCRYPTION_SECRET = "test-secret-at-least-16-chars-long"; });

// The module reads the secret lazily per call, so import order doesn't matter.
const { encrypt, decrypt, isLegacy, encryptV1ForTests, cryptoReady } = await import("../api/_crypto.js");

const AAD = "00000000-0000-0000-0000-0000000000a1:anthropic";

describe("_crypto v2", () => {
  it("round-trips a value with its aad and marks it v2", () => {
    const secret = "sk-ant-api03-abc123def456";
    const blob = encrypt(secret, AAD);
    expect(blob.startsWith("v2:")).toBe(true);
    expect(isLegacy(blob)).toBe(false);
    expect(decrypt(blob, AAD)).toBe(secret);
  });

  it("refuses to encrypt without an aad", () => {
    expect(() => encrypt("x")).toThrow();
  });

  it("fails to decrypt with a different aad (another user's or provider's row)", () => {
    const blob = encrypt("sk-ant-secret", AAD);
    expect(() => decrypt(blob, "00000000-0000-0000-0000-0000000000b2:anthropic")).toThrow();
    expect(() => decrypt(blob, "00000000-0000-0000-0000-0000000000a1:marketcheck")).toThrow();
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encrypt("same", AAD)).not.toBe(encrypt("same", AAD));
  });

  it("fails to decrypt tampered ciphertext", () => {
    const blob = encrypt("sk-ant-secret", AAD);
    const buf = Buffer.from(blob.slice(3), "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decrypt("v2:" + buf.toString("base64"), AAD)).toThrow();
  });

  it("cryptoReady reflects the configured secret", () => {
    expect(cryptoReady()).toBe(true);
  });
});

describe("_crypto legacy v1", () => {
  it("still decrypts a v1 ciphertext (any aad) and reports it as legacy", () => {
    const blob = encryptV1ForTests("sk-ant-old");
    expect(isLegacy(blob)).toBe(true);
    expect(decrypt(blob)).toBe("sk-ant-old");
    expect(decrypt(blob, AAD)).toBe("sk-ant-old");
  });
});
