import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, TokenDecryptionError } from "./token-crypto.js";

/** 32-byte key, base64 — format enforced by the env schema (plan §7.2). */
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const OTHER_KEY = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

describe("token crypto (Slice 1.6, ruling 2 — AES-256-GCM)", () => {
  it("round-trips a token", () => {
    const blob = encryptToken("ya29.fake-access-token", KEY);
    expect(decryptToken(blob, KEY)).toBe("ya29.fake-access-token");
  });

  it("uses the v1.<iv>.<tag>.<ciphertext> format and never contains the plaintext", () => {
    const blob = encryptToken("super-secret-refresh-token", KEY);
    const parts = blob.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(blob).not.toContain("super-secret-refresh-token");
  });

  it("produces a fresh IV per call (same plaintext → different ciphertext)", () => {
    expect(encryptToken("same", KEY)).not.toBe(encryptToken("same", KEY));
  });

  it("rejects tampered ciphertext", () => {
    const blob = encryptToken("token", KEY);
    const parts = blob.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptToken(parts.join("."), KEY)).toThrow(TokenDecryptionError);
  });

  it("rejects the wrong key", () => {
    expect(() => decryptToken(encryptToken("token", KEY), OTHER_KEY)).toThrow(TokenDecryptionError);
  });

  it("rejects malformed blobs and unknown versions", () => {
    expect(() => decryptToken("not-a-blob", KEY)).toThrow(TokenDecryptionError);
    expect(() => decryptToken("v9.x.y.z", KEY)).toThrow(TokenDecryptionError);
  });

  it("rejects a key that is not 32 bytes once decoded", () => {
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => encryptToken("token", shortKey)).toThrow();
  });
});
