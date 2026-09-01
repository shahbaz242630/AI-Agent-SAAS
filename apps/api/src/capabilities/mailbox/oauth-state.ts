import { jwtVerify, SignJWT } from "jose";
import { isModuleKey, type ModuleKey } from "@eva/types";

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
 * ⚠️ `OAuthFlow` LIVED HERE AND IS DELETED (slice 3.1c-0b). It existed for ONE
 * job: deciding whether the callback returned the browser to `/app/onboarding`
 * or to the mailbox settings screen. Both ends of that choice are gone —
 * onboarding stopped asking for a mailbox, and the return path is now derived
 * from the PRODUCT the connection was for.
 *
 * What was left was an enum with ONE reachable value, threaded through the
 * signed state, the validation schema, a server action and a hidden form
 * field, deciding nothing — the `ends_at` trap migration 0024 named:
 * machinery whose only value is the one nobody varies.
 *
 * ⚠️ THE SAFETY PROPERTY IT CARRIED IS UNCHANGED. The callback builds its
 * destination from the signed state and a server-side rule, NEVER from
 * anything the caller supplies. Accepting a redirect target from the client —
 * even a signed one — would be an open redirect the moment a token leaked,
 * and the provider's redirect_uri allowlist would not catch it, because the
 * hop happens after we are back on our own origin.
 */

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
  /**
   * WHICH PRODUCT this mailbox is being connected for (ruling 36, slice
   * 3.1c-0). It rides on the signed state because the browser is away at
   * Google or Microsoft in between and nothing else survives the round trip.
   *
   * ⚠️ OPTIONAL ONLY BECAUSE `admin_consent` SHARES THIS TYPE. For a `connect`
   * state it is mandatory and `verifyOAuthState` refuses without it; admin
   * consent is one Microsoft tenant approving the Eva app and connects no
   * mailbox, so it has no product to name. Read a connect state through
   * `verifyConnectState`, which carries that guarantee in its return type.
   *
   * ⚠️ AND UNLIKE `flow` AND `replacesMailboxId` IT IS NEVER QUIETLY DROPPED.
   * Those two degrade to a safe default when unreadable — you land on a real
   * screen, or a replace becomes a plain connect, and nothing is lost. There is
   * no safe default for this one: guessing files the mailbox under the wrong
   * product, bills another product's seat, and shows green on every screen
   * while the first reply leaves the wrong account. A connect state without it
   * is refused, which costs a customer one "please try again" and costs a
   * mis-filed mailbox nothing at all.
   */
  moduleKey?: ModuleKey;
  /** The address the user typed in Eva, so the callback can still name it
   *  after Microsoft declines â€” Microsoft tells us nothing about who tried. */
  loginHint?: string;
  /**
   * The mailbox this connection REPLACES (slice 1.6b, ruling 3), so the new
   * address inherits its clients and its default status.
   *
   * It rides on the signed state for the same reason `flow` does: the browser
   * is at Microsoft in between and nothing else survives the round trip. Being
   * signed proves we minted it, but it is still re-validated at the callback —
   * the mailbox may have been disconnected by a colleague during the round
   * trip, in which case the connection degrades to a plain one rather than
   * failing.
   */
  replacesMailboxId?: string;
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
    /**
     * Dropped rather than rejected if it is not uuid-shaped, for the same
     * reason as `flow`: the signature already proves we minted this token, so a
     * malformed value means our own code changed, not that anyone is attacking.
     * Dropping degrades a replace into a plain connect — the old mailbox and
     * its clients stay exactly as they were, which is the safe direction.
     */
    const replacesMailboxId = payload.replacesMailboxId;
    /**
     * ⚠️ THE ONE CLAIM THAT REFUSES RATHER THAN DEGRADES. See the field's note:
     * every other optional claim has a safe fallback and this one has none.
     * A token minted before slice 3.1c-0 carries no product, so a connection
     * in flight across that deploy is refused and retried — deliberately
     * chosen over completing it against a guessed product.
     */
    const moduleKey = payload.moduleKey;
    const moduleKeyIsUsable = typeof moduleKey === "string" && isModuleKey(moduleKey);
    /**
     * ⚠️ REQUIRED FOR `connect`, ABSENT FOR `admin_consent`, AND THE ASYMMETRY
     * IS THE MODEL RATHER THAN AN OVERSIGHT. Admin consent is one Microsoft
     * TENANT approving the Eva app; it connects no mailbox and belongs to no
     * product, so demanding one there would invent a fact. A connect writes a
     * mailbox row, and that row must name its product.
     */
    if (expectedPurpose === "connect" && !moduleKeyIsUsable) {
      throw new InvalidOAuthStateError();
    }
    return {
      organisationId: readUuidClaim(payload.organisationId),
      userId: readUuidClaim(payload.userId),
      nonce,
      purpose: expectedPurpose,
      ...(moduleKeyIsUsable ? { moduleKey: moduleKey as ModuleKey } : {}),
      ...(typeof loginHint === "string" &&
      loginHint.length > 0 &&
      loginHint.length <= MAX_LOGIN_HINT_LENGTH
        ? { loginHint }
        : {}),
      ...(typeof replacesMailboxId === "string" && UUID_PATTERN.test(replacesMailboxId)
        ? { replacesMailboxId }
        : {}),
    };
  } catch {
    throw new InvalidOAuthStateError();
  }
}

/** A connect state's claims, with the product the callback is about to write. */
export type ConnectStateClaims = OAuthStateClaims & { moduleKey: ModuleKey };

/**
 * Verify a state that is completing a mailbox CONNECT.
 *
 * ⚠️ EXISTS SO THE CALLBACK NEVER WRITES `claims.moduleKey!`. `verifyOAuthState`
 * already refuses a connect state with no usable product, but its return type
 * cannot say so — the same function serves admin consent, where the field is
 * legitimately absent. A non-null assertion at the call site would be correct
 * today and silently wrong the first time somebody widens the purpose enum;
 * this carries the guarantee in the type instead.
 */
export async function verifyConnectState(
  secret: string,
  state: string,
): Promise<ConnectStateClaims> {
  const claims = await verifyOAuthState(secret, state, "connect");
  if (!claims.moduleKey) throw new InvalidOAuthStateError();
  return { ...claims, moduleKey: claims.moduleKey };
}
