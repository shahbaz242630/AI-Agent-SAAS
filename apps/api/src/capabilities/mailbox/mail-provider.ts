/**
 * OAuth token set from a mail provider. Never logged (BRD 14).
 *
 * ⚠️ THESE TYPES LIVE HERE RATHER THAN IN THE MICROSOFT FOLDER, AND NOT ONLY
 * FOR TIDINESS. The port already re-exports the shared ERRORS; had it kept
 * importing its types back out of `microsoft-graph-provider.ts` the two files
 * would import each other, and `no-circular` — one of the two walls — fails the
 * build on exactly that. A port that depends on one of its implementations is
 * not a port, and the cruiser is what says so out loud.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Token lifetime from the token endpoint (`expires_in`). */
  expiresInSeconds: number;
  /** Granted scopes, space-split from the token response. */
  scopes: string[];
}

/** The connected mailbox's identity, as the provider reports it. */
export interface MailboxProfile {
  emailAddress: string;
  displayName: string | null;
}

export interface SendMailInput {
  to: string;
  subject: string;
  bodyText: string;
  /**
   * The connected mailbox's own address.
   *
   * ⚠️ CARRIED RATHER THAN LOOKED UP, BECAUSE GMAIL COMPOSES THE WHOLE MESSAGE.
   * Graph sends as the authenticated user and needs no `From`; Gmail is handed
   * a complete RFC 5322 message, which has one. The first cut fetched the
   * profile inside `sendMail` to find it — an extra network round trip on every
   * single email, and one more thing that can fail between a customer's chaser
   * and their debtor. The caller has always had this to hand.
   *
   * Optional because Microsoft ignores it, and because Gmail fills in the
   * authenticated address itself when the header is absent — so a missing value
   * degrades to correct rather than to wrong.
   */
  from?: string;
}

/** Optional targeting for the authorize URL (onboarding Part A, F5). */
export interface AuthorizeUrlOptions {
  /**
   * The address the user typed in Eva, passed to the provider as `login_hint`
   * so somebody signed into two accounts lands on the right one.
   */
  loginHint?: string;
}

/**
 * The mailbox capability's provider port (Slice 3.1b, step 2).
 *
 * ⚠️ THIS IS THE ABSTRACTION THE SECOND PROVIDER EARNED, AND NOT A LINE EARLIER.
 * `ARCHITECTURE-PLATFORM-AND-PRODUCTS.md` §8 is explicit that speculative
 * abstractions are how the wrong shape gets built: "the second product earns
 * the abstraction". Microsoft was the only mailbox anyone could connect until
 * now, so `MicrosoftGraphProvider` being the only port was correct. Gmail is
 * the second, and it is what makes the shape observable rather than imagined.
 *
 * ⚠️ IT IS DELIBERATELY THE SAME SHAPE AS `MicrosoftGraphProvider`, NOT A
 * REDESIGN. The methods were chosen against a real provider and have survived a
 * live product; inventing a "better" interface at the moment a second one
 * arrives would mean changing the working implementation and the new one at the
 * same time, with nothing left to compare against.
 *
 * ⚠️ WHAT IS *NOT* HERE IS AS IMPORTANT. Admin consent and domain discovery are
 * Microsoft's model of an organisation approving an app; Google has no
 * equivalent. They stay on the Microsoft adapter rather than being widened into
 * the port and left permanently null for everyone else.
 */
export interface MailProvider {
  /** The provider's authorize URL for one state value. */
  buildAuthorizeUrl(state: string, options?: AuthorizeUrlOptions): string;
  /** authorization_code → tokens. Throws ReauthRequiredError on invalid_grant. */
  exchangeCode(code: string): Promise<OAuthTokens>;
  /** refresh_token → fresh tokens. Throws ReauthRequiredError on invalid_grant. */
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  /** The connected mailbox's own identity. */
  getProfile(accessToken: string): Promise<MailboxProfile>;
  /** Send one message from the connected mailbox. */
  sendMail(accessToken: string, input: SendMailInput): Promise<void>;
  /**
   * "Does this account actually have a usable mailbox?" — checked at connect so
   * a licensing problem surfaces then rather than at the first customer
   * reminder. Throws MailboxUnavailableError when there is none.
   */
  probeMailbox(accessToken: string): Promise<void>;
}

/**
 * The grant is dead — the mailbox must be reconnected.
 *
 * ⚠️ MOVED HERE FROM THE MICROSOFT MODULE (3.1b step 2). It was never
 * Microsoft's: `outbound-mail.ts` catches it for any provider, and
 * `mailboxes.service.ts` maps it to `health_status = 'auth_expired'` for any
 * mailbox. Leaving it behind would have meant a Gmail adapter importing an
 * error out of the Microsoft folder in order to say something that has nothing
 * to do with Microsoft.
 */
export class ReauthRequiredError extends Error {
  constructor() {
    super("Authorisation expired — reconnect the mailbox");
    this.name = "ReauthRequiredError";
  }
}

/**
 * The grant is fine — there is no usable mailbox behind it.
 *
 * ⚠️ THE MESSAGE IS THE PROVIDER'S, NOT OURS, AND IT REACHES THE CUSTOMER.
 * `sendTestEmail` puts it straight into a `BadRequestException` and into
 * `last_error` on the mailbox row. Microsoft's wording was chosen carefully
 * under defect F1's rule — when two causes are indistinguishable, say so rather
 * than guess — so it is passed in rather than replaced by something generic.
 */
export class MailboxUnavailableError extends Error {
  constructor(message = "Eva couldn't open that mailbox") {
    super(message);
    this.name = "MailboxUnavailableError";
  }
}

/**
 * Any other provider-side failure. `Retry-After` is surfaced for 429 (BRD §4.1)
 * so the sender can defer rather than fail a reminder.
 *
 * ⚠️ RENAMED FROM `GraphRequestError`. `outbound-mail.ts` decides whether a
 * failed send is retryable by testing for this class — so a Gmail adapter that
 * threw anything else would silently lose Google's rate limits and 5xxs into
 * the "permanent failure" branch, and a customer's chaser would be binned the
 * first time Google had a busy minute. The old name would have made throwing it
 * from a Google adapter look wrong, which is exactly how that bug gets written.
 */
export class MailProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "MailProviderRequestError";
  }
}

/** DI token for the map of provider key → adapter. */
export const MAIL_PROVIDERS = Symbol("MAIL_PROVIDERS");

/**
 * Every provider a mailbox row may name.
 *
 * ⚠️ THIS LIST AND THE `email_accounts_provider_check` CONSTRAINT ARE ONE FACT
 * WRITTEN TWICE, AND `mailbox-providers.spec.ts` FAILS IF THEY DISAGREE. That
 * test is the real guard here. Widen the CHECK without adding an adapter and
 * every mailbox on the new provider becomes unusable at send time; add an
 * adapter without widening the CHECK and nobody can ever connect one. Neither
 * failure announces itself, and both are invisible until a customer's mail
 * stops.
 */
export const MAIL_PROVIDER_KEYS = ["microsoft", "google"] as const;

export type MailProviderKey = (typeof MAIL_PROVIDER_KEYS)[number];

export type MailProviderRegistry = ReadonlyMap<string, MailProvider>;

/**
 * A mailbox row names a provider we have no adapter for.
 *
 * ⚠️ DISTINCT FROM `ReauthRequiredError`, AND THE F3 DEFECT IS WHY. When Graph
 * answered a licence-less account with a 401, the customer was told to
 * reconnect — which could never fix it, so they looped forever. "Reconnect this
 * mailbox" is equally useless here: the grant is fine, WE are the ones missing
 * a piece. Anything that maps this onto a reauth prompt is repeating that bug.
 *
 * Unreachable while the CHECK and `MAIL_PROVIDER_KEYS` agree, which is what the
 * spec enforces. It exists so that if they ever stop agreeing, the failure is
 * named rather than a `undefined is not a function`.
 */
export class UnknownMailProviderError extends Error {
  constructor(readonly provider: string) {
    super(`No mail adapter is registered for provider '${provider}'`);
    this.name = "UnknownMailProviderError";
  }
}

/** The adapter for a mailbox, or a named failure. Never `undefined`. */
export function providerFor(registry: MailProviderRegistry, provider: string): MailProvider {
  const adapter = registry.get(provider);
  if (!adapter) throw new UnknownMailProviderError(provider);
  return adapter;
}
