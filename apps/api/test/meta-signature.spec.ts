import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyMetaSignature,
  verifySubscriptionHandshake,
} from "../src/capabilities/messaging/meta/meta-signature.js";

/**
 * The WhatsApp front door's only authentication (slice 3.2c).
 *
 * ⚠️ THIS ROUTE IS PUBLIC AND REACHABLE BY ANYONE WHO LEARNS THE URL. There is
 * no JWT — Meta has never signed in. Everything downstream happens on the
 * strength of what these two functions decide, which is the same position
 * `resend-webhook-signature.spec.ts` holds for email.
 */

const SECRET = "test-app-secret-not-a-real-one";

const sign = (secret: string, body: Buffer) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifying a Meta webhook signature", () => {
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));

  it("accepts a payload signed with the app secret", () => {
    expect(verifyMetaSignature(SECRET, sign(SECRET, body), body)).toEqual({ ok: true });
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL. A verifier that returned `{ ok: true }`
   * unconditionally passes the test above forever.
   */
  it("refuses a payload signed with a different secret", () => {
    const result = verifyMetaSignature(SECRET, sign("someone-elses-secret", body), body);
    expect(result.ok).toBe(false);
  });

  it("refuses a payload whose body was altered after signing", () => {
    const signature = sign(SECRET, body);
    const tampered = Buffer.from(
      JSON.stringify({ object: "whatsapp_business_account", entry: [1] }),
    );
    expect(verifyMetaSignature(SECRET, signature, tampered).ok).toBe(false);
  });

  /**
   * 🚨 THE ONE THAT WOULD HAVE BROKEN THE UAE AND NOWHERE ELSE.
   *
   * Meta's Messenger docs say the signature is computed over an escaped-unicode
   * rendering of the payload; the WhatsApp page does not repeat it. Either way,
   * hashing the RAW BYTES is correct — the discrepancy only appears when
   * somebody parses and re-serialises before hashing.
   *
   * This proves the non-ASCII path works end to end, and the second assertion
   * proves that the re-serialised bytes really are different, so the test is
   * about something rather than passing by coincidence.
   */
  it("accepts a non-ASCII payload, and re-serialising it would not match", () => {
    const raw = Buffer.from(
      JSON.stringify({ text: "مرحبا، أحتاج سباكاً", name: "Zoë Müller", emoji: "🔧" }),
      "utf8",
    );
    const signature = sign(SECRET, raw);

    expect(verifyMetaSignature(SECRET, signature, raw)).toEqual({ ok: true });

    // What a parse/stringify round trip with escaping would produce instead.
    const reserialised = Buffer.from(
      JSON.stringify(JSON.parse(raw.toString("utf8"))).replace(
        /[-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
      "utf8",
    );
    expect(reserialised.equals(raw), "the two renderings must differ, or this proves nothing").toBe(
      false,
    );
    expect(verifyMetaSignature(SECRET, signature, reserialised).ok).toBe(false);
  });

  /**
   * ⚠️ AN UNCONFIGURED SECRET REFUSES EVERYTHING. The tempting shape is "no
   * secret set, so skip verification", which opens the door precisely on the
   * environment where somebody forgot to configure it. Fail closed — the rule
   * `ResendWebhookGuard` already states for the email door.
   */
  it("refuses everything when no app secret is configured", () => {
    expect(verifyMetaSignature("", sign(SECRET, body), body).ok).toBe(false);
  });

  it("refuses a missing header", () => {
    expect(verifyMetaSignature(SECRET, null, body).ok).toBe(false);
  });

  /**
   * ⚠️ `header.split("=")[1]` WOULD ACCEPT THIS. Meta once used SHA-1, and a
   * lazy prefix strip compares our SHA-256 digest against a SHA-1 one — always
   * false, so it fails closed, but for a reason nobody could diagnose.
   */
  it("refuses a sha1 signature rather than silently comparing it", () => {
    const sha1 = createHmac("sha1", SECRET).update(body).digest("hex");
    const result = verifyMetaSignature(SECRET, `sha1=${sha1}`, body);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("not a sha256 signature");
  });

  it("refuses a header that is not lower-case hex", () => {
    expect(verifyMetaSignature(SECRET, "sha256=NOTHEX", body).ok).toBe(false);
  });

  /**
   * ⚠️ A LENGTH MISMATCH MUST NOT THROW. `timingSafeEqual` raises on unequal
   * lengths, so a short forged signature would be a 500 rather than a 401 —
   * telling an attacker the difference between "wrong shape" and "wrong value"
   * from the status code alone.
   */
  it("refuses a too-short signature without throwing", () => {
    expect(() => verifyMetaSignature(SECRET, "sha256=abcd", body)).not.toThrow();
    expect(verifyMetaSignature(SECRET, "sha256=abcd", body).ok).toBe(false);
  });
});

describe("the subscription handshake Meta performs before delivering anything", () => {
  const TOKEN = "eva-wa-verify-token-for-tests";

  /**
   * ⚠️ THE CHALLENGE IS ECHOED VERBATIM. Meta compares the response body to the
   * string it sent, so wrapping it as JSON fails verification while looking
   * entirely reasonable — and a failed handshake means Meta marks the endpoint
   * unverified and sends NOTHING, silently.
   */
  it("returns the challenge when the token matches", () => {
    const result = verifySubscriptionHandshake(TOKEN, {
      mode: "subscribe",
      token: TOKEN,
      challenge: "1158201444",
    });
    expect(result).toEqual({ ok: true, challenge: "1158201444" });
  });

  it("refuses a token that does not match", () => {
    const result = verifySubscriptionHandshake(TOKEN, {
      mode: "subscribe",
      token: "guessed",
      challenge: "1158201444",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a mode that is not subscribe", () => {
    const result = verifySubscriptionHandshake(TOKEN, {
      mode: "unsubscribe",
      token: TOKEN,
      challenge: "1158201444",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses when no verify token is configured", () => {
    const result = verifySubscriptionHandshake("", {
      mode: "subscribe",
      token: "",
      challenge: "1158201444",
    });
    expect(result.ok).toBe(false);
  });

  /**
   * ⚠️ AN EMPTY CHALLENGE IS NOT A MISSING ONE, AND BOTH MUST BE HANDLED. Meta
   * sends a random string; a `null` means the parameter was absent, which is a
   * malformed request rather than a failed check.
   */
  it("refuses a missing challenge", () => {
    const result = verifySubscriptionHandshake(TOKEN, {
      mode: "subscribe",
      token: TOKEN,
      challenge: null,
    });
    expect(result.ok).toBe(false);
  });

  /**
   * 🚨 THE CHALLENGE IS REFLECTED INTO THE RESPONSE OF A PUBLIC ROUTE. CodeQL
   * flagged the echo as reflected XSS on PR #136. Meta's challenge is a random
   * integer, so only a plain token is ever echoed; anything carrying markup,
   * whitespace or an unbounded length is refused before it can reach a body.
   * ⚠️ MUST-FAIL CASES: a verifier that echoed everything passes the test above
   * and every one of these.
   */
  it("refuses a challenge that is not a plain token, so nothing unsafe is ever echoed", () => {
    for (const challenge of [
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "1158201444 ",
      "1158201444\n",
      "",
      "a".repeat(257),
    ]) {
      const result = verifySubscriptionHandshake(TOKEN, {
        mode: "subscribe",
        token: TOKEN,
        challenge,
      });
      expect(result.ok, `should refuse ${JSON.stringify(challenge)}`).toBe(false);
    }
  });

  it("accepts the shapes Meta actually sends: digits, and the unreserved URL characters", () => {
    for (const challenge of ["1158201444", "abc-DEF_123.~", "a".repeat(256)]) {
      const result = verifySubscriptionHandshake(TOKEN, {
        mode: "subscribe",
        token: TOKEN,
        challenge,
      });
      expect(result).toEqual({ ok: true, challenge });
    }
  });
});
