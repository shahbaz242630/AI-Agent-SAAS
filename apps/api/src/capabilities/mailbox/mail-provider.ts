import type {
  AuthorizeUrlOptions,
  MailboxProfile,
  OAuthTokens,
  SendMailInput,
} from "./microsoft-graph/microsoft-graph-provider.js";

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
export const MAIL_PROVIDER_KEYS = ["microsoft"] as const;

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
