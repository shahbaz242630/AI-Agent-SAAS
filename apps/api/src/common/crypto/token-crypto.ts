import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Token encryption at rest (Slice 1.6, ruling 2): AES-256-GCM with the key
 * from TOKEN_ENCRYPTION_KEY (32 bytes, base64). Storage format
 * `v1.<iv>.<tag>.<ciphertext>` (each base64) — the version prefix allows a
 * future key-rotation migration without a flag day. First encryption at
 * rest in the repo: keep every consumer on this helper (mailboxes today).
 */

const VERSION = "v1";
const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32;

/** Thrown for any ciphertext that does not verify — never leak why beyond this. */
export class TokenDecryptionError extends Error {
  constructor() {
    super("stored token could not be decrypted");
    this.name = "TokenDecryptionError";
  }
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encryptToken(plaintext: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptToken(blob: string, keyBase64: string): string {
  try {
    const parts = blob.split(".");
    const [version, iv, tag, ciphertext] = parts;
    // Exactly four parts: GCM authenticates the four that matter, but accepting
    // trailing junk would quietly bless a malformed blob.
    if (parts.length !== 4 || version !== VERSION || !iv || !tag || !ciphertext) {
      throw new Error("bad format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      decodeKey(keyBase64),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TokenDecryptionError();
  }
}
