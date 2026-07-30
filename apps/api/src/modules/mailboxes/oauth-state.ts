import { jwtVerify, SignJWT } from "jose";

/**
 * OAuth `state` parameter (Slice 1.6, ruling 4): a stateless HS256 JWT
 * binding the flow to one organisation + initiating user, with a 10-minute
 * TTL. The callback route is @Public — this signature + expiry is the
 * entire CSRF defence. Org-binding makes cross-org CSRF ineffective: an
 * attacker cannot mint a state naming a victim org without membership.
 */

const ALGORITHM = "HS256";
const TTL = "10m";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OAuthStateClaims {
  organisationId: string;
  userId: string;
  nonce: string;
}

/** Thrown for any state that does not verify — signature, expiry, or shape. */
export class InvalidOAuthStateError extends Error {
  constructor() {
    super("the connection attempt expired or was invalid — please try again");
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

export async function signOAuthState(secret: string, claims: OAuthStateClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(key(secret));
}

export async function verifyOAuthState(secret: string, state: string): Promise<OAuthStateClaims> {
  try {
    // Pinning the algorithm keeps verification to the one we mint (BRD 13).
    const { payload } = await jwtVerify(state, key(secret), { algorithms: [ALGORITHM] });
    const nonce = payload.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) throw new InvalidOAuthStateError();
    return {
      organisationId: readUuidClaim(payload.organisationId),
      userId: readUuidClaim(payload.userId),
      nonce,
    };
  } catch {
    throw new InvalidOAuthStateError();
  }
}
