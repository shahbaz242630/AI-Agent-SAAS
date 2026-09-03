import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Proving a webhook really came from Meta (slice 3.2c).
 *
 * Meta signs every webhook payload with HMAC-SHA256, keyed by the app secret,
 * and puts the result in `X-Hub-Signature-256` prefixed with `sha256=`. This is
 * the WhatsApp front door's only authentication — the route is public and
 * reachable by anyone who learns the URL, exactly like the Resend one, and the
 * same reasoning applies: everything downstream happens on the strength of what
 * this function decides.
 *
 * 🚨 THE BYTES MATTER, AND THIS IS WHERE META DIFFERS FROM EVERY OTHER
 * PROVIDER WE INTEGRATE. Their Messenger documentation states the signature is
 * computed over an **escaped-unicode** rendering of the payload with lowercase
 * hex — *"if you just calculate against the decoded bytes, you will end up with
 * a different signature"*, their example being `äöå` → `äöå`.
 * The WhatsApp page does not repeat that caveat, so whether it applies to both
 * is **unverified**.
 *
 * ⚠️ IT DOES NOT MATTER, PROVIDED NOBODY RE-SERIALISES. The discrepancy only
 * arises from `JSON.parse` → `JSON.stringify` → hash, because that round trip
 * is what changes the escaping. Hashing the raw request bytes exactly as they
 * arrived sidesteps it whichever way the caveat falls. **So this function takes
 * a Buffer and there is no overload that takes an object** — the type is the
 * guard, because a comment would not have been.
 *
 * ⚠️ AND IT WOULD HAVE FAILED ONLY ON NON-ASCII MESSAGES. An accented surname,
 * an emoji, any Arabic at all. Invisible on a UK test bench and broken outright
 * in the UAE — one of the two markets ruling 62 names.
 */

/** Header Meta sends. Lower-cased because Node lower-cases header names. */
export const META_SIGNATURE_HEADER = "x-hub-signature-256";

const PREFIX = "sha256=";

export type SignatureResult = { ok: true } | { ok: false; reason: string };

/**
 * Constant-time compare of two hex digests.
 *
 * ⚠️ `timingSafeEqual` THROWS ON A LENGTH MISMATCH rather than returning false,
 * so the length is checked first. A forged header of the wrong length would
 * otherwise be a 500 instead of a 401 — an attacker learning the difference
 * between "wrong shape" and "wrong value" from the status code.
 */
function digestsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param appSecret the Meta app secret — the HMAC key.
 * @param header    the `X-Hub-Signature-256` value, `sha256=<hex>`.
 * @param rawBody   the request body EXACTLY as received. Never a re-serialised
 *                  object; see the note above.
 */
export function verifyMetaSignature(
  appSecret: string,
  header: string | null,
  rawBody: Buffer,
): SignatureResult {
  if (!appSecret) return { ok: false, reason: "no app secret is configured" };
  if (!header) return { ok: false, reason: `${META_SIGNATURE_HEADER} header is missing` };

  /**
   * ⚠️ THE PREFIX IS CHECKED, NOT STRIPPED BLINDLY. `header.split("=")[1]` is
   * the common shape and it is wrong: it silently accepts `sha1=<hex>`, which
   * is a weaker algorithm Meta also once used, and would compare our SHA-256
   * digest against a SHA-1 one — always false, so it fails closed, but for a
   * reason nobody could diagnose from the logs.
   */
  if (!header.startsWith(PREFIX)) {
    return { ok: false, reason: `${META_SIGNATURE_HEADER} is not a sha256 signature` };
  }

  const provided = header.slice(PREFIX.length);
  if (!/^[0-9a-f]+$/.test(provided)) {
    return { ok: false, reason: `${META_SIGNATURE_HEADER} is not lower-case hex` };
  }

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (!digestsMatch(expected, provided)) {
    return { ok: false, reason: "signature does not match" };
  }
  return { ok: true };
}

/**
 * The GET handshake Meta performs before it will deliver anything.
 *
 * ⚠️ META RE-SENDS THIS EVERY TIME THE CALLBACK URL OR VERIFY TOKEN IS EDITED,
 * not only once at setup. An endpoint that answered it correctly on the day and
 * stopped later would silently stop receiving webhooks — Meta marks the
 * endpoint unverified and sends nothing, with no error anywhere on our side.
 *
 * ⚠️ AND THE CHALLENGE IS ECHOED VERBATIM, AS THE BODY. Not JSON, not wrapped:
 * Meta compares the response body to the string it sent. Returning
 * `{"challenge": "..."}` fails verification while looking entirely reasonable.
 */
export interface VerificationQuery {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}

export type VerificationResult = { ok: true; challenge: string } | { ok: false; reason: string };

/**
 * What a challenge is allowed to look like before we will echo it.
 *
 * ⚠️ THE ECHO IS A REFLECTED VALUE ON A PUBLIC ROUTE, AND CODEQL SAID SO
 * (PR #136, `js/reflected-xss`, high). The body is served as `text/plain`
 * with `nosniff`, so a browser would not run it — but "the browser would not"
 * is a weaker guarantee than "there is nothing to run". Meta's challenge is a
 * random integer, so a plain token is all we ever need to echo: digits,
 * letters and the four unreserved URL characters, up to 256 of them. Anything
 * else is not a handshake and is refused before it reaches the response.
 */
const PLAIN_CHALLENGE = /^[0-9A-Za-z._~-]{1,256}$/;

export function verifySubscriptionHandshake(
  configuredToken: string,
  query: VerificationQuery,
): VerificationResult {
  if (!configuredToken) return { ok: false, reason: "no verify token is configured" };
  if (query.mode !== "subscribe") return { ok: false, reason: "hub.mode is not subscribe" };
  if (query.challenge === null) return { ok: false, reason: "hub.challenge is missing" };
  if (!PLAIN_CHALLENGE.test(query.challenge)) {
    return { ok: false, reason: "hub.challenge is not a plain token" };
  }
  /**
   * Constant-time again. This one is lower stakes than the payload signature —
   * the token guards which endpoint Meta talks to, not what it is allowed to
   * say — but it is a secret compared against attacker-supplied input, and
   * there is no reason to make it the one place we compare secrets carelessly.
   */
  if (query.token === null || !digestsMatch(configuredToken, query.token)) {
    return { ok: false, reason: "hub.verify_token does not match" };
  }
  return { ok: true, challenge: query.challenge };
}
