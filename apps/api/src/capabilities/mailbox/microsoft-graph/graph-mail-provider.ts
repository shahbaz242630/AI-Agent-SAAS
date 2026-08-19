import { Inject, Injectable } from "@nestjs/common";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
import type {
  AuthorizeUrlOptions,
  MailboxProfile,
  MicrosoftGraphProvider,
  OAuthTokens,
  SendMailInput,
} from "./microsoft-graph-provider.js";
import {
  GraphRequestError,
  MailboxUnavailableError,
  ReauthRequiredError,
} from "./microsoft-graph-provider.js";

/**
 * Hand-rolled Microsoft identity platform + Graph client (Slice 1.6,
 * ruling 3): two token-endpoint calls and two Graph calls — MSAL's cache
 * model would fight the per-org encrypted DB token storage. Never log tokens
 * or authorization codes (BRD 14); Microsoft error bodies are summarised
 * rather than echoed, because they can quote back request material.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Minimal delegated scopes (plan §10). `offline_access` is what yields a refresh token. */
const SCOPES = "offline_access User.Read Mail.Read Mail.Send";

/** Graph error codes meaning "the grant is fine, this account has no mailbox"
 *  rather than "the grant is dead" (F3). Lower-cased for comparison. */
const MAILBOX_MISSING_CODES = new Set([
  "mailboxnotenabledforrestapi",
  "mailboxnothostedinexchangeonline",
  "restapinotenabledforuser",
]);

/**
 * Reads ONLY Graph's `error.code` enum from a 401 body. A body we cannot parse
 * deliberately answers false: mistaking a real expired grant for "you have no
 * mailbox" would tell a user with a perfectly good mailbox to go and buy one.
 */
async function readGraphErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.clone().json()) as { error?: { code?: unknown } };
    const code = payload.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function isMailboxMissing(code: string | null): boolean {
  return code !== null && MAILBOX_MISSING_CODES.has(code.toLowerCase());
}

@Injectable()
export class GraphMailProvider implements MicrosoftGraphProvider {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /** Tenant `common` = any organisational directory (multi-tenant, ruling 3). */
  private get loginBase(): string {
    return `https://login.microsoftonline.com/${this.env.MICROSOFT_TENANT}/oauth2/v2.0`;
  }

  /**
   * Defect F5: this used to send neither `login_hint` nor `prompt`, so
   * Microsoft silently reused whatever session existed and a user signed into
   * two accounts could connect the wrong mailbox without ever seeing a picker.
   *
   * `login_hint` is the reliable mechanism (verified against real Microsoft
   * 2026-07-30). `prompt=select_account` is belt and braces only — it was
   * IGNORED once a session context existed, so nothing may depend on it. The
   * actual guarantee is showing the connected address back to the user.
   */
  buildAuthorizeUrl(state: string, options: AuthorizeUrlOptions = {}): string {
    const params = new URLSearchParams({
      client_id: this.env.MICROSOFT_CLIENT_ID,
      response_type: "code",
      redirect_uri: this.env.MICROSOFT_OAUTH_REDIRECT_URI,
      response_mode: "query",
      scope: SCOPES,
      prompt: "select_account",
      state,
    });
    if (options.loginHint) params.set("login_hint", options.loginHint);
    return `${this.loginBase}/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.env.MICROSOFT_OAUTH_REDIRECT_URI,
      scope: SCOPES,
    });
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async tokenRequest(extra: Record<string, string>): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: this.env.MICROSOFT_CLIENT_ID,
      client_secret: this.env.MICROSOFT_CLIENT_SECRET,
      ...extra,
    });
    const response = await fetch(`${this.loginBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // invalid_grant is the one recoverable-by-reconnecting case (ruling 10).
      if (payload.error === "invalid_grant") throw new ReauthRequiredError();
      throw new GraphRequestError("Microsoft token endpoint rejected the request", response.status);
    }
    const accessToken = payload.access_token;
    const refreshToken = payload.refresh_token;
    // A 200 missing either token would otherwise be coerced to the literal
    // "undefined" and encrypted as though it were real — fail loudly instead.
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new GraphRequestError("Microsoft token response had no access token", response.status);
    }
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      throw new GraphRequestError("Microsoft token response had no refresh token", response.status);
    }
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Number(payload.expires_in ?? 3600),
      scopes: String(payload.scope ?? "")
        .split(" ")
        .filter(Boolean),
    };
  }

  async getProfile(accessToken: string): Promise<MailboxProfile> {
    const payload = await this.graphRequest<{
      displayName?: string | null;
      mail?: string | null;
      userPrincipalName?: string | null;
    }>(accessToken, `${GRAPH_BASE}/me?$select=displayName,mail,userPrincipalName`);
    const emailAddress = payload.mail ?? payload.userPrincipalName;
    if (!emailAddress) {
      throw new GraphRequestError("Microsoft profile had no mailbox address", 200);
    }
    return { emailAddress, displayName: payload.displayName ?? null };
  }

  async sendMail(accessToken: string, input: SendMailInput): Promise<void> {
    await this.graphRequest(accessToken, `${GRAPH_BASE}/me/sendMail`, {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: "Text", content: input.bodyText },
          toRecipients: [{ emailAddress: { address: input.to } }],
        },
        saveToSentItems: true,
      }),
    });
  }

  /**
   * "Does this account actually have a mailbox?" — one cheap read, run at
   * connect time so a licensing problem is caught while the user is watching,
   * not at the first customer reminder in slice 1.7 (defect F3). The inbox
   * folder is the smallest thing Mail.Read can ask for.
   *
   * A 401 HERE means "no mailbox", not "dead grant", and the ordering is what
   * makes that sound: connect calls getProfile FIRST, so /me has already
   * answered 200 with this very token. The grant is provably alive; only the
   * mailbox can be missing.
   *
   * That ordering argument is load-bearing rather than decorative. Observed
   * against a real licence-less account on 2026-07-31, Graph answers this
   * endpoint with a bare 401 — **no WWW-Authenticate header and an empty
   * body** — so there is no error code to match on. Detection by error code
   * alone silently fails, which is exactly what it did.
   */
  async probeMailbox(accessToken: string): Promise<void> {
    try {
      await this.graphRequest(accessToken, `${GRAPH_BASE}/me/mailFolders/inbox?$select=id`, {
        unauthorizedMeans: "mailbox_missing",
      });
    } catch (error) {
      if (error instanceof MailboxUnavailableError) throw error;
      /**
       * ANY failure here means the same thing to the customer: we could not
       * open their mailbox, so storing this connection would hand slice 1.7 a
       * mailbox it cannot send through.
       *
       * Mapping only 401 was not enough, and that is not a theory — the SAME
       * licence-less account answered a bare 401 on 2026-07-31 and an
       * HTTP 500 (with `Retry-After: 10`) on 2026-08-01, observed on staging.
       * The 500 fell through to GraphRequestError and the customer was told
       * "please try again", which for an account with no mailbox is the exact
       * infinite loop F3 exists to remove.
       *
       * The ordering argument is what makes this safe, and it does not depend
       * on the status code: `getProfile` succeeded moments ago with this very
       * token, so the grant is provably alive. Whatever just failed, it is not
       * authorisation.
       *
       * The cost is that a genuinely transient Graph outage now reads as
       * "mailbox unavailable" too. That is why the copy names BOTH causes
       * rather than asserting the licence — the same rule F1 established for
       * a declined consent: when two causes are indistinguishable, say so
       * instead of guessing, because guessing is wrong half the time.
       */
      throw new MailboxUnavailableError();
    }
  }

  private async graphRequest<T = unknown>(
    accessToken: string,
    url: string,
    init: { method?: string; body?: string; unauthorizedMeans?: "reauth" | "mailbox_missing" } = {},
  ): Promise<T> {
    const { unauthorizedMeans = "reauth", ...requestInit } = init;
    const response = await fetch(url, {
      ...requestInit,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401) {
      // Not every 401 is a dead grant: an account with no Exchange licence is
      // refused with 401 too, and telling that user to "reconnect" loops them
      // forever (F3).
      //
      // Two ways to tell them apart, because Microsoft is not consistent:
      // 1. The caller knows. probeMailbox runs straight after a successful
      //    /me, so the grant cannot be dead — see its doc comment. This is the
      //    reliable one.
      // 2. Graph sometimes names the reason in error.code. Read only that enum
      //    field, never the free-text message — Microsoft bodies can quote
      //    request material back, so the no-echo rule still holds.
      if (unauthorizedMeans === "mailbox_missing") throw new MailboxUnavailableError();
      if (isMailboxMissing(await readGraphErrorCode(response))) {
        throw new MailboxUnavailableError();
      }
      throw new ReauthRequiredError();
    }
    if (!response.ok) {
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
      throw new GraphRequestError(
        "Microsoft Graph rejected the request",
        response.status,
        Number.isNaN(retryAfter) ? null : retryAfter,
      );
    }
    // sendMail answers 202 with no body; 204 covers other no-content replies.
    if (response.status === 202 || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
