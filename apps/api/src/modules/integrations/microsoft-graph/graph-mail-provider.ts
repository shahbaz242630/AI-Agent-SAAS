import { Inject, Injectable } from "@nestjs/common";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
import type {
  MailboxProfile,
  MicrosoftGraphProvider,
  OAuthTokens,
  SendMailInput,
} from "./microsoft-graph-provider.js";
import { GraphRequestError, ReauthRequiredError } from "./microsoft-graph-provider.js";

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

@Injectable()
export class GraphMailProvider implements MicrosoftGraphProvider {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /** Tenant `common` = any organisational directory (multi-tenant, ruling 3). */
  private get loginBase(): string {
    return `https://login.microsoftonline.com/${this.env.MICROSOFT_TENANT}/oauth2/v2.0`;
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.env.MICROSOFT_CLIENT_ID,
      response_type: "code",
      redirect_uri: this.env.MICROSOFT_OAUTH_REDIRECT_URI,
      response_mode: "query",
      scope: SCOPES,
      state,
    });
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

  private async graphRequest<T = unknown>(
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
