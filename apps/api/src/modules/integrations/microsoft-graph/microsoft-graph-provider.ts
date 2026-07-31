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

/** OAuth token set from the Microsoft identity platform. Never logged (BRD 14). */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Token lifetime from the token endpoint (`expires_in`). */
  expiresInSeconds: number;
  /** Granted scopes, space-split from the token response. */
  scopes: string[];
}

/** The connected mailbox identity, from Graph /me. */
export interface MailboxProfile {
  /** `mail` when present, else `userPrincipalName`. */
  emailAddress: string;
  displayName: string | null;
}

export interface SendMailInput {
  to: string;
  subject: string;
  bodyText: string;
}

/** Optional targeting for the authorize URL (Slice onboarding Part A, F5). */
export interface AuthorizeUrlOptions {
  /** The address the user typed in Eva, passed to Microsoft as `login_hint` so
   *  someone signed into two accounts lands on the right one. */
  loginHint?: string;
}

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
}

/**
 * Microsoft says the grant is dead (invalid_grant on exchange/refresh, 401 on
 * Graph): the mailbox must be reconnected. Mapped to health_status
 * 'auth_expired' by the mailboxes module (ruling 10).
 */
export class ReauthRequiredError extends Error {
  constructor() {
    super("Microsoft authorisation expired — reconnect the mailbox");
    this.name = "ReauthRequiredError";
  }
}

/**
 * The grant is fine — the account has no mailbox to use (no Exchange Online
 * licence, or mailbox not hosted in Exchange Online). Graph reports this as a
 * 401, which is why it used to be mistaken for a dead grant (defect F3): the
 * user was told to reconnect, which can never fix it, so they looped forever.
 *
 * Distinct from ReauthRequiredError because the remedy is completely
 * different — connect a different account, or buy a licence.
 */
export class MailboxUnavailableError extends Error {
  constructor() {
    super(
      "This Microsoft account doesn't have a mailbox — it may not have an Exchange Online licence",
    );
    this.name = "MailboxUnavailableError";
  }
}

/** Any other Microsoft-side failure. `Retry-After` surfaced for 429 (BRD §4.1). */
export class GraphRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "GraphRequestError";
  }
}
