import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifying that an inbound webhook really came from Resend (Slice 3.1b).
 *
 * ⚠️ THIS IS THE ONLY THING BETWEEN THE PUBLIC INTERNET AND A CUSTOMER'S LEAD
 * BOOK. The webhook route cannot carry a Supabase JWT — it is called by a
 * machine that has never signed in — so there is no user, no organisation and
 * no session behind it. The signature IS the authentication. If it is wrong,
 * anyone who learns the URL can post fabricated enquiries into any customer's
 * book, and once Eva answers (3.1c) she answers them in that customer's name.
 *
 * Resend signs with Svix's scheme:
 *
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   signature      = base64( HMAC-SHA256( secret, signed content ) )
 *   header         = "v1,<sig> v1,<other sig>"   (space-separated, may be many)
 *
 * ⚠️ WRITTEN OUT RATHER THAN TAKEN FROM THE `svix` PACKAGE, AND THE REASON IS
 * NOT "NOT INVENTED HERE". It is forty lines of HMAC over a documented string,
 * every branch of it is tested here including the failures, and each of the
 * four ways this is usually got wrong — a non-constant-time compare, a missing
 * timestamp window, only checking the first of several signatures, and
 * forgetting that the secret is base64 behind a `whsec_` prefix — is a test
 * below that goes red when it is removed. A dependency we cannot see inside is
 * a worse trade for a two-person team than forty lines we can.
 */

/**
 * How far out of step a webhook's clock may be. Svix's own default.
 *
 * ⚠️ WITHOUT THIS, A CAPTURED WEBHOOK IS VALID FOREVER. The signature covers
 * the timestamp, so an attacker cannot change it — but they do not need to.
 * They can replay the original bytes, exactly as sent, a year later. The window
 * is what turns "was this signed by Resend" into "was this signed by Resend
 * just now".
 */
const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export type VerificationFailure =
  "missing-headers" | "bad-timestamp" | "timestamp-out-of-tolerance" | "no-signature-matched";

export type VerificationResult = { ok: true } | { ok: false; reason: VerificationFailure };

/**
 * `whsec_aGVsbG8=` → the raw key bytes.
 *
 * The prefix is presentation, not part of the key. Signing with the prefix
 * still included produces a signature that never matches, and the symptom —
 * every webhook rejected — looks identical to a wrong secret.
 */
function secretBytes(secret: string): Buffer {
  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(withoutPrefix, "base64");
}

/** Constant-time, and length-checked first because timingSafeEqual throws. */
function matches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this request really from Resend, and recent?
 *
 * ⚠️ THE BODY MUST BE THE RAW BYTES, NOT A RE-SERIALISED OBJECT. `JSON.stringify`
 * of a parsed payload is not the same string that was signed — key order, unicode
 * escaping and whitespace all differ — so a verifier fed the parsed body rejects
 * every genuine webhook. Nest is booted with `rawBody: true` for this one reason.
 */
export function verifyResendSignature(
  secret: string,
  headers: SvixHeaders,
  rawBody: Buffer,
  now: Date = new Date(),
): VerificationResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing-headers" };

  const sentAtSeconds = Number(timestamp);
  if (!Number.isFinite(sentAtSeconds)) return { ok: false, reason: "bad-timestamp" };

  // Both directions: a webhook from the future is as suspicious as a stale one,
  // and clock skew cuts both ways.
  const driftSeconds = Math.abs(Math.floor(now.getTime() / 1000) - sentAtSeconds);
  if (driftSeconds > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp-out-of-tolerance" };
  }

  const signedContent = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secretBytes(secret)).update(signedContent).digest("base64");

  /**
   * ⚠️ EVERY SIGNATURE IN THE HEADER, NOT THE FIRST. Svix sends more than one
   * while a secret is being rotated, and the valid one is not reliably first.
   * Checking only the first turns a rotation into an outage in which every
   * enquiry is silently rejected as forged.
   *
   * `v1a` and any later scheme are ignored rather than trusted: an unknown
   * prefix is not a signature we know how to check.
   */
  const candidates = signature
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice("v1,".length));

  for (const candidate of candidates) {
    if (matches(expected, candidate)) return { ok: true };
  }
  return { ok: false, reason: "no-signature-matched" };
}

/** Signs the way Resend does — used by the tests, and by nothing else. */
export function signForTest(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  const signedContent = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  return `v1,${createHmac("sha256", secretBytes(secret)).update(signedContent).digest("base64")}`;
}
