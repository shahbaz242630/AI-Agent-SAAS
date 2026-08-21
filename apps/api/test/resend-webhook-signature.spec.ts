import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signForTest,
  verifyResendSignature,
} from "../src/capabilities/mailbox/inbound/resend-webhook-signature.js";

/**
 * The only authentication on the inbound webhook (Slice 3.1b).
 *
 * ⚠️ EVERY TEST HERE IS A WAY IN. The route is `@Public()`: no JWT, no session,
 * no organisation. If verification is wrong, anyone who learns the URL can post
 * fabricated enquiries into any customer's lead book — and once Eva answers
 * (3.1c) she answers them from that customer's own mailbox, in their name.
 *
 * The four failures this scheme is usually got wrong on each have a test:
 * a compare that is not constant-time, a missing timestamp window, checking
 * only the first of several signatures, and forgetting the secret is base64
 * behind a `whsec_` prefix.
 */

const SECRET = `whsec_${Buffer.from("a-test-signing-secret").toString("base64")}`; // gitleaks:allow — fake test fixture
const BODY = Buffer.from(JSON.stringify({ type: "email.received", data: { email_id: "abc" } }));
const ID = "msg_2abc";

const nowSeconds = () => Math.floor(Date.now() / 1000).toString();

const headersFor = (timestamp = nowSeconds(), body = BODY, secret = SECRET) => ({
  id: ID,
  timestamp,
  signature: signForTest(secret, ID, timestamp, body),
});

describe("Resend webhook signatures: what must be accepted", () => {
  it("accepts a webhook Resend really signed", () => {
    expect(verifyResendSignature(SECRET, headersFor(), BODY)).toEqual({ ok: true });
  });

  /**
   * ⚠️ SVIX SENDS SEVERAL SIGNATURES WHILE A SECRET IS BEING ROTATED, AND THE
   * VALID ONE IS NOT RELIABLY FIRST. Checking only the first turns a routine
   * rotation into an outage where every real enquiry is rejected as forged —
   * and the log would say "no signature matched", which reads like an attack.
   */
  it("accepts when the valid signature is not the first one offered", () => {
    const timestamp = nowSeconds();
    const valid = signForTest(SECRET, ID, timestamp, BODY);
    const other = signForTest(
      `whsec_${Buffer.from("a-different-secret").toString("base64")}`, // gitleaks:allow — fake test fixture
      ID,
      timestamp,
      BODY,
    );
    const result = verifyResendSignature(
      SECRET,
      { id: ID, timestamp, signature: `${other} ${valid}` },
      BODY,
    );
    expect(result).toEqual({ ok: true });
  });

  /**
   * The prefix is presentation, not key material. Signing with it still
   * attached produces a signature that never matches — and the symptom, every
   * webhook rejected, is identical to simply having the wrong secret.
   */
  it("treats the secret the same with or without its whsec_ prefix", () => {
    const bare = SECRET.slice("whsec_".length);
    const timestamp = nowSeconds();
    const signature = signForTest(SECRET, ID, timestamp, BODY);
    expect(verifyResendSignature(bare, { id: ID, timestamp, signature }, BODY)).toEqual({
      ok: true,
    });
  });

  /** Clock skew cuts both ways; a few seconds either side is not an attack. */
  it("tolerates a small clock difference in both directions", () => {
    const now = Math.floor(Date.now() / 1000);
    for (const skew of [-60, 60, -299, 299]) {
      const timestamp = (now + skew).toString();
      expect(
        verifyResendSignature(SECRET, headersFor(timestamp), BODY),
        `skew ${skew}s should be tolerated`,
      ).toEqual({ ok: true });
    }
  });
});

describe("Resend webhook signatures: what must be refused", () => {
  it("refuses a body that has been changed by so much as one character", () => {
    const timestamp = nowSeconds();
    const signature = signForTest(SECRET, ID, timestamp, BODY);
    const tampered = Buffer.from(
      JSON.stringify({ type: "email.received", data: { email_id: "abd" } }),
    );
    expect(verifyResendSignature(SECRET, { id: ID, timestamp, signature }, tampered)).toEqual({
      ok: false,
      reason: "no-signature-matched",
    });
  });

  it("refuses a signature made with a different secret", () => {
    const wrong = `whsec_${Buffer.from("not-our-secret").toString("base64")}`; // gitleaks:allow — fake test fixture
    expect(verifyResendSignature(SECRET, headersFor(nowSeconds(), BODY, wrong), BODY)).toEqual({
      ok: false,
      reason: "no-signature-matched",
    });
  });

  /**
   * ⚠️ THE REPLAY WINDOW. The signature covers the timestamp, so an attacker
   * cannot change it — but they do not need to. They can resend the original
   * bytes, byte for byte, a year later, and without this window it verifies
   * perfectly. That is a captured enquiry re-injected at will.
   */
  it("refuses a webhook replayed outside the tolerance window", () => {
    const stale = (Math.floor(Date.now() / 1000) - 60 * 60).toString();
    expect(verifyResendSignature(SECRET, headersFor(stale), BODY)).toEqual({
      ok: false,
      reason: "timestamp-out-of-tolerance",
    });
  });

  it("refuses a webhook dated in the future", () => {
    const ahead = (Math.floor(Date.now() / 1000) + 60 * 60).toString();
    expect(verifyResendSignature(SECRET, headersFor(ahead), BODY)).toEqual({
      ok: false,
      reason: "timestamp-out-of-tolerance",
    });
  });

  it("refuses a timestamp that is not a number", () => {
    const timestamp = "not-a-timestamp";
    expect(
      verifyResendSignature(
        SECRET,
        { id: ID, timestamp, signature: signForTest(SECRET, ID, timestamp, BODY) },
        BODY,
      ),
    ).toEqual({ ok: false, reason: "bad-timestamp" });
  });

  it("refuses when any of the three headers is absent", () => {
    const timestamp = nowSeconds();
    const signature = signForTest(SECRET, ID, timestamp, BODY);
    for (const headers of [
      { id: undefined, timestamp, signature },
      { id: ID, timestamp: undefined, signature },
      { id: ID, timestamp, signature: undefined },
      { id: "", timestamp, signature },
    ]) {
      expect(verifyResendSignature(SECRET, headers, BODY)).toEqual({
        ok: false,
        reason: "missing-headers",
      });
    }
  });

  /**
   * ⚠️ AN UNKNOWN SCHEME IS NOT A SIGNATURE WE CAN CHECK. Svix reserves `v1a`
   * for asymmetric signatures, which are verified with a public key and not
   * with this HMAC. Accepting one because it "looks like a signature" would
   * mean trusting bytes nothing verified.
   */
  it("ignores signature schemes it does not understand", () => {
    const timestamp = nowSeconds();
    const raw = createHmac("sha256", Buffer.from(SECRET.slice("whsec_".length), "base64"))
      .update(`${ID}.${timestamp}.${BODY.toString("utf8")}`)
      .digest("base64");
    // Correct bytes, wrong scheme label: must not be accepted.
    expect(
      verifyResendSignature(SECRET, { id: ID, timestamp, signature: `v1a,${raw}` }, BODY),
    ).toEqual({ ok: false, reason: "no-signature-matched" });
  });

  it("refuses an empty signature header", () => {
    expect(
      verifyResendSignature(SECRET, { id: ID, timestamp: nowSeconds(), signature: " " }, BODY),
    ).toEqual({ ok: false, reason: "no-signature-matched" });
  });

  /**
   * ⚠️ THE RE-SERIALISATION TRAP, WRITTEN DOWN AS A TEST. `JSON.stringify` of a
   * parsed payload is not the string that was signed — key order and spacing
   * differ — so a verifier handed the parsed body rejects every genuine
   * webhook while looking entirely correct. This is why the app boots with
   * `rawBody: true`.
   */
  it("refuses a body that was parsed and re-serialised", () => {
    const timestamp = nowSeconds();
    const signature = signForTest(SECRET, ID, timestamp, BODY);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY.toString("utf8"))) + " ");
    expect(verifyResendSignature(SECRET, { id: ID, timestamp, signature }, reserialised)).toEqual({
      ok: false,
      reason: "no-signature-matched",
    });
  });
});
