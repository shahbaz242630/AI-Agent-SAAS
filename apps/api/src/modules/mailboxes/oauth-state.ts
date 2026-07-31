import { jwtVerify, SignJWT } from "jose";

/**
 * OAuth `state` parameter (Slice 1.6, ruling 4): a stateless HS256 JWT
 * binding the flow to one organisation + initiating user, with a 30-minute
 * TTL. The callback route is @Public â€” this signature + expiry is the
 * entire CSRF defence. Org-binding makes cross-org CSRF ineffective: an
 * attacker cannot mint a state naming a victim org without membership.
 */

const ALGORITHM = "HS256";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A login_hint is an email address; cap it so a hostile state cannot bloat the URL. */
const MAX_LOGIN_HINT_LENGTH = 320;

/**
 * What a state token is allowed to complete.
 *
 * `connect` is the short-lived CSRF token of ruling 4, unchanged. `admin_consent`
 * exists because the admin-approval journey is *asynchronous by design*: the
 * customer forwards a link to whoever runs their IT, who may open it hours or
 * days later. Ten minutes would expire before it was ever clicked.
 *
 * The longer life is affordable only because the two are not interchangeable â€”
 * verification demands the purpose it expects. An `admin_consent` token grants
 * nothing on its own: it names the organisation whose approval screen this was,
 * so the return can be attributed and audited. It cannot complete a connect.
 */
export type OAuthStatePurpose = "connect" | "admin_consent";

/**
 * `connect` was 10 minutes and that is NOT long enough â€” proven on 2026-07-31,
 * when a first-time sign-in (password, MFA on a phone, reading the consent
 * screen, then stepping away) blew through it and the customer got
 * "the connection attempt expired or was invalid" with no hint that they had
 * simply taken too long.
 *
 * Thirty minutes is still a short window for a CSRF token that is org-bound
 * and useless without a matching authorization code, and it comfortably covers
 * a human doing this for the first time on an unfamiliar tenant.
 */
const TTL: Record<OAuthStatePurpose, string> = {
  connect: "30m",
  admin_consent: "7d",
};

export interface OAuthStateClaims {
  organisationId: string;
  userId: string;
  nonce: string;
  purpose: OAuthStatePurpose;
  /** The address the user typed in Eva, so the callback can still name it
   *  after Microsoft declines â€” Microsoft tells us nothing about who tried. */
  loginHint?: string;
}

/** Thrown for any state that does not verify â€” signature, expiry, or shape. */
export class InvalidOAuthStateError extends Error {
  constructor() {
    super("the connection attempt expired or was invalid â€” please try again");
    this.name = "InvalidOAuthStateError";
  }
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Claims are read back defensively rather than coerced with String(): a
 * missing claim would otherwise become the literal "undefined" and reach
 * withTenant, where Postgres fails the ::uuid cast as a 500 instead of the
 * clean ?error=invalid_state redirect the callback owes the user. (Same
 * defect class as the Task 4 String(payload.refresh_token) fix.)
 */
function readUuidClaim(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new InvalidOAuthStateError();
  return value;
}

export async function signOAuthState(
  secret: string,
  claims: Omit<OAuthStateClaims, "purpose"> & { purpose?: OAuthStatePurpose },
): Promise<string> {
  const purpose = claims.purpose ?? "connect";
  return new SignJWT({ ...claims, purpose })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(TTL[purpose])
    .sign(key(secret));
}

/**
 * `expectedPurpose` is not optional in spirit: a token minted for the
 * seven-day admin-consent flow must not be able to complete a connect, which
 * is the only thing that makes the longer life safe. A token with no purpose
 * claim is read as `connect` so tokens already in flight across a deploy still
 * work â€” admin-consent tokens always carry theirs explicitly.
 */
export async function verifyOAuthState(
  secret: string,
  state: string,
  expectedPurpose: OAuthStatePurpose = "connect",
): Promise<OAuthStateClaims> {
  try {
    // Pinning the algorithm keeps verification to the one we mint (BRD 13).
    const { payload } = await jwtVerify(state, key(secret), { algorithms: [ALGORITHM] });
    const nonce = payload.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) throw new InvalidOAuthStateError();
    const purpose = payload.purpose ?? "connect";
    if (purpose !== expectedPurpose) throw new InvalidOAuthStateError();
    const loginHint = payload.loginHint;
    return {
      organisationId: readUuidClaim(payload.organisationId),
      userId: readUuidClaim(payload.userId),
      nonce,
      purpose: expectedPurpose,
      ...(typeof loginHint === "string" &&
      loginHint.length > 0 &&
      loginHint.length <= MAX_LOGIN_HINT_LENGTH
        ? { loginHint }
        : {}),
    };
  } catch {
    throw new InvalidOAuthStateError();
  }
}
