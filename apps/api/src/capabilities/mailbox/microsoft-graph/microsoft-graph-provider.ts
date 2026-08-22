/**
 * Microsoft Graph provider adapter (BRD §11; Slice 1.6 plan §7.5, ruling 5):
 * the ONLY place Microsoft endpoints are called. Hand-rolled OAuth via fetch
 * (ruling 3 — no MSAL: its cache model fights per-org encrypted DB token
 * storage). The port mirrors the extraction-adapter pattern — a Symbol DI
 * token plus plain interfaces, bound by the consuming module (mailboxes) so
 * tests substitute a stub via overrideProvider.
 */

/** DI token for the active Microsoft Graph provider. */
export const MICROSOFT_GRAPH_PROVIDER = Symbol("MICROSOFT_GRAPH_PROVIDER");

/**
 * ⚠️ THE SHARED TYPES MOVED TO `../mail-provider.ts` IN 3.1b, for the same
 * reason the errors did: they describe any mail provider, not Microsoft's. They
 * are re-exported here so the Microsoft files that use them read naturally,
 * and so the dependency still points one way — port ← implementation.
 */
export type {
  AuthorizeUrlOptions,
  MailboxProfile,
  OAuthTokens,
  SendMailInput,
} from "../mail-provider.js";

// Re-exporting does not bring the names into THIS file scope, and the
// interface below uses them.
import type {
  AuthorizeUrlOptions,
  MailboxProfile,
  OAuthTokens,
  SendMailInput,
} from "../mail-provider.js";

export interface MicrosoftGraphProvider {
  /** The https://login.microsoftonline.com authorize URL for one state value. */
  buildAuthorizeUrl(state: string, options?: AuthorizeUrlOptions): string;
  /** authorization_code → tokens. Throws ReauthRequiredError on invalid_grant. */
  exchangeCode(code: string): Promise<OAuthTokens>;
  /** refresh_token → fresh tokens. Throws ReauthRequiredError on invalid_grant. */
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  /** GET /me — the connected mailbox's own profile. */
  getProfile(accessToken: string): Promise<MailboxProfile>;
  /** POST /me/sendMail (saveToSentItems). */
  sendMail(accessToken: string, input: SendMailInput): Promise<void>;
  /** Cheap "does this account actually have a mailbox?" check, so a licensing
   *  problem is caught at connect rather than at the first customer reminder
   *  (F3). Throws MailboxUnavailableError when there is no mailbox. */
  probeMailbox(accessToken: string): Promise<void>;
  /** "Was permission to send actually granted?" — see the port. Microsoft's
   *  answer is already proven by `probeMailbox`; the implementation says why. */
  assertSendPermission(scopes: readonly string[]): void;
}

/**
 * ⚠️ THE SHARED ERRORS MOVED TO `../mail-provider.ts` IN 3.1b. `ReauthRequiredError`,
 * `MailboxUnavailableError` and `MailProviderRequestError` (formerly
 * `GraphRequestError`) are the port's, not Microsoft's — every provider raises
 * them and `outbound-mail.ts` routes on them. Import them from there.
 */
export {
  MailboxUnavailableError,
  MailProviderRequestError,
  ReauthRequiredError,
} from "../mail-provider.js";
