import { Inject, Injectable } from "@nestjs/common";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
import {
  MailProviderRequestError,
  ReauthRequiredError,
  type AuthorizeUrlOptions,
  type MailboxProfile,
  type MailProvider,
  type OAuthTokens,
  type SendMailInput,
} from "../mail-provider.js";
import { buildRfc822, toBase64Url } from "./rfc822.js";

/**
 * Gmail adapter (Slice 3.1b, step 3) — the ONLY place Google endpoints are
 * called. Hand-rolled via fetch, mirroring the Microsoft adapter for the same
 * reason (ruling 3): a client library's token cache fights per-org encrypted
 * database storage.
 *
 * ⚠️ `gmail.send` AND NOTHING MORE (ruling 25). Reading a Gmail inbox is a
 * *restricted* scope on Google's own classification — a security assessment
 * every 12 months, 4–12 weeks to approval, a 100-user cap until it clears.
 * `gmail.send` is merely *sensitive*: one review, no audit, no fee. Anyone
 * adding `gmail.readonly`, `gmail.modify`, `gmail.metadata` or `gmail.compose`
 * to the list below is signing us up for an annual bill; enquiries reach us
 * through the front door we own instead (3.1b step 1).
 *
 * `openid email profile` are not Gmail scopes and cost nothing — they are how
 * we learn which address just connected.
 */
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email", "profile"].join(
  " ",
);

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

@Injectable()
export class GmailProvider implements MailProvider {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /**
   * ⚠️ `access_type=offline` AND `prompt=consent`, AND REMOVING EITHER BREAKS
   * RECONNECTING IN A WAY NOTHING WILL REPORT.
   *
   * Google returns a refresh token ONLY when `access_type=offline` is set — and
   * on a SECOND authorisation by the same user it returns none at all unless
   * the consent screen is forced. That second case is exactly the reconnect
   * path: somebody whose grant died comes back to fix it, Google skips consent
   * because they already agreed once, and we get an access token good for an
   * hour and nothing to renew it with. The mailbox appears to reconnect and
   * dies again before lunch.
   *
   * It is not a rare path either. While the OAuth app is in **Testing**
   * publishing status Google expires the grant — and its refresh token — SEVEN
   * DAYS after consent, so every test user reconnects weekly by design.
   *
   * Verified against Google's own documentation 2026-08-21, not from memory.
   */
  buildAuthorizeUrl(state: string, options: AuthorizeUrlOptions = {}): string {
    const params = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID,
      redirect_uri: this.env.GOOGLE_OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      // Belt and braces against a signed-in-to-two-accounts mix-up, the same
      // defect F5 that bit the Microsoft flow.
      include_granted_scopes: "true",
      state,
    });
    if (options.loginHint) params.set("login_hint", options.loginHint);
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.env.GOOGLE_OAUTH_REDIRECT_URI,
    });
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    return this.tokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      // ⚠️ A REFRESH RESPONSE CARRIES NO NEW REFRESH TOKEN, AND THAT IS NORMAL.
      // Google returns only an access token here and expects the original
      // refresh token to keep being used. The Microsoft adapter treats a
      // missing refresh token as a fault because Microsoft rotates them on
      // every refresh; applying that rule to Google would fail every single
      // renewal, i.e. every mailbox would die one hour after connecting.
      refreshToken,
    );
  }

  private async tokenRequest(
    extra: Record<string, string>,
    existingRefreshToken?: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID,
        client_secret: this.env.GOOGLE_CLIENT_SECRET,
        ...extra,
      }).toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      /**
       * `invalid_grant` is Google saying the grant is dead — revoked in the
       * user's account settings, expired (the 7-day Testing window), or the
       * code already used. The only fix is reconnecting, which is what this
       * error means everywhere else in the capability.
       */
      if (payload.error === "invalid_grant") throw new ReauthRequiredError();
      // The status, never the body: Google's error bodies quote request
      // material back, and this string is logged.
      throw new MailProviderRequestError(
        "Google token endpoint rejected the request",
        response.status,
      );
    }

    const accessToken = payload.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new MailProviderRequestError(
        "Google token response had no access token",
        response.status,
      );
    }

    const returnedRefresh = payload.refresh_token;
    const refreshToken =
      typeof returnedRefresh === "string" && returnedRefresh.length > 0
        ? returnedRefresh
        : existingRefreshToken;
    /**
     * ⚠️ NO REFRESH TOKEN ON AN *EXCHANGE* IS A REAL FAULT, NOT A QUIRK. It
     * means `access_type=offline` or `prompt=consent` went missing from the
     * authorize URL — and storing the connection anyway would give the customer
     * a mailbox that works for exactly one hour and then asks to be reconnected
     * forever. Fail here, while somebody is watching the screen.
     */
    if (!refreshToken) {
      throw new MailProviderRequestError(
        "Google returned no refresh token — the authorize URL is missing access_type=offline or prompt=consent",
        response.status,
      );
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
    const payload = await this.googleRequest<{ email?: unknown; name?: unknown }>(
      accessToken,
      USERINFO_URL,
    );
    const emailAddress = typeof payload.email === "string" ? payload.email : null;
    if (!emailAddress) {
      throw new MailProviderRequestError("Google profile had no email address", 200);
    }
    return {
      emailAddress,
      displayName: typeof payload.name === "string" ? payload.name : null,
    };
  }

  /**
   * ⚠️ GMAIL WANTS A WHOLE RFC 5322 MESSAGE, NOT FIELDS. Graph is given
   * `{subject, body, toRecipients}` and composes the mail itself; Gmail takes
   * one base64url blob. `rfc822.ts` builds it, and carries the header-injection
   * and encoding guards that composing our own message makes necessary.
   *
   * `From` is the connected address, passed in by the caller. Gmail refuses to
   * send as anybody else regardless — which is the guarantee ruling 25 rests
   * on: the reply comes from the customer's own mailbox, on their own domain,
   * with their own DKIM. Omitting the header entirely is safe for the same
   * reason; Gmail fills in the authenticated address.
   */
  async sendMail(accessToken: string, input: SendMailInput): Promise<void> {
    const raw = toBase64Url(
      buildRfc822({
        ...(input.from ? { from: input.from } : {}),
        to: input.to,
        subject: input.subject,
        bodyText: input.bodyText,
      }),
    );
    await this.googleRequest(accessToken, SEND_URL, {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
  }

  /**
   * ⚠️ DELIBERATELY A NO-OP, AND THE HONEST REASON IS THAT WE CANNOT ASK.
   *
   * Microsoft's probe exists because an account can authenticate perfectly and
   * still have no mailbox behind it (no Exchange Online licence) — so connect
   * reads the inbox folder to find out before storing anything (defect F3).
   *
   * The equivalent Gmail question is `users.getProfile`, and it needs
   * `gmail.metadata`, `gmail.readonly` or `gmail.modify` — every one of them a
   * RESTRICTED scope costing an annual audit (ruling 25). Buying a licence
   * check for the price of a yearly security assessment is the wrong trade.
   *
   * ⚠️ WHAT COVERS IT INSTEAD: the welcome test email. `handleCallback` sends
   * one immediately after connecting, so a Workspace account with Gmail
   * switched off fails there — while the customer is still watching — rather
   * than silently at the first customer reminder. That is the same protection
   * F3 asked for, arriving one step later.
   *
   * Resolving rather than throwing is correct: pretending to have checked would
   * be worse than not checking.
   */
  async probeMailbox(): Promise<void> {
    return Promise.resolve();
  }

  private async googleRequest<T = unknown>(
    accessToken: string,
    url: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 401) throw new ReauthRequiredError();

    if (!response.ok) {
      /**
       * `Retry-After` is surfaced so `outbound-mail.ts` can DEFER rather than
       * fail. Google rate-limits per user per second, which bites exactly when
       * a customer's book is big — the same failure mode that used to bin
       * Microsoft reminders under load.
       */
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new MailProviderRequestError(
        `Google rejected the request (HTTP ${response.status})`,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }

    return (await response.json().catch(() => ({}))) as T;
  }
}
