import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { GraphMailProvider } from "./graph-mail-provider.js";
import {
  GraphRequestError,
  MailboxUnavailableError,
  ReauthRequiredError,
} from "./microsoft-graph-provider.js";

/**
 * The hand-rolled Microsoft identity/Graph client (Slice 1.6, ruling 3).
 * `fetch` is stubbed throughout — no network, no Entra app registration
 * needed, so the build never blocks on the founder's portal work (plan §4).
 */

const ENV = {
  MICROSOFT_CLIENT_ID: "client-id-123",
  MICROSOFT_CLIENT_SECRET: "client-secret-abc", // gitleaks:allow — fake test fixture
  MICROSOFT_TENANT: "common",
  MICROSOFT_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/microsoft/callback",
} as ApiEnv;

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  // `input` is deliberately unknown: this project has no DOM lib, so the
  // global `RequestInfo` type is unavailable — we only need the URL string.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => handler(String(input), init ?? {})),
  );
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("GraphMailProvider (Slice 1.6, ruling 3 — hand-rolled OAuth)", () => {
  const provider = new GraphMailProvider(ENV);

  it("buildAuthorizeUrl targets the v2.0 endpoint with minimal scopes + state", () => {
    const url = new URL(provider.buildAuthorizeUrl("state-xyz"));
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.MICROSOFT_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read Mail.Send");
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });

  it("never puts the client secret in the authorize URL", () => {
    expect(provider.buildAuthorizeUrl("state-xyz")).not.toContain("client-secret-abc");
  });

  it("exchangeCode posts the grant and maps the token response", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth-code-1");
      expect(body.get("client_id")).toBe("client-id-123");
      expect(body.get("client_secret")).toBe("client-secret-abc");
      expect(body.get("redirect_uri")).toBe(ENV.MICROSOFT_OAUTH_REDIRECT_URI);
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: "offline_access User.Read Mail.Read Mail.Send",
      });
    });
    await expect(provider.exchangeCode("auth-code-1")).resolves.toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresInSeconds: 3600,
      scopes: ["offline_access", "User.Read", "Mail.Read", "Mail.Send"],
    });
  });

  it("exchangeCode maps invalid_grant to ReauthRequiredError", async () => {
    stubFetch(() => jsonResponse(400, { error: "invalid_grant", error_description: "bad code" }));
    await expect(provider.exchangeCode("bad")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("refreshTokens posts the refresh grant", async () => {
    stubFetch((url, init) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-old");
      return jsonResponse(200, {
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 5400,
        scope: "Mail.Send",
      });
    });
    const tokens = await provider.refreshTokens("refresh-old");
    expect(tokens.accessToken).toBe("access-2");
    expect(tokens.expiresInSeconds).toBe(5400);
  });

  it("refreshTokens maps invalid_grant (revoked consent) to ReauthRequiredError", async () => {
    stubFetch(() => jsonResponse(400, { error: "invalid_grant" }));
    await expect(provider.refreshTokens("dead")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  // A 200 that omits either token would otherwise be stringified into the
  // literal "undefined" and encrypted as if it were a real token — fail loudly
  // instead of persisting garbage that breaks the next refresh.
  it("rejects a 200 token response missing access_token or refresh_token", async () => {
    stubFetch(() => jsonResponse(200, { access_token: "only-access", expires_in: 3600 }));
    await expect(provider.exchangeCode("code")).rejects.toBeInstanceOf(GraphRequestError);
    stubFetch(() => jsonResponse(200, { refresh_token: "only-refresh", expires_in: 3600 }));
    await expect(provider.exchangeCode("code")).rejects.toBeInstanceOf(GraphRequestError);
  });

  it("getProfile prefers mail, falls back to userPrincipalName", async () => {
    stubFetch((url, init) => {
      expect(url).toContain("https://graph.microsoft.com/v1.0/me");
      expect(init.headers).toMatchObject({ Authorization: "Bearer access-1" });
      return jsonResponse(200, {
        displayName: "Sandbox",
        mail: null,
        userPrincipalName: "sb@example.com",
      });
    });
    await expect(provider.getProfile("access-1")).resolves.toEqual({
      emailAddress: "sb@example.com",
      displayName: "Sandbox",
    });
  });

  it("sendMail posts the message with saveToSentItems and accepts 202", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body)) as {
        saveToSentItems: boolean;
        message: {
          toRecipients: { emailAddress: { address: string } }[];
          body: { contentType: string };
        };
      };
      expect(body.saveToSentItems).toBe(true);
      expect(body.message.toRecipients[0]?.emailAddress.address).toBe("to@example.com");
      expect(body.message.body.contentType).toBe("Text");
      return new Response(null, { status: 202 });
    });
    await expect(
      provider.sendMail("access-1", { to: "to@example.com", subject: "s", bodyText: "b" }),
    ).resolves.toBeUndefined();
  });

  it("surfaces 429 with Retry-After seconds (BRD §4.1)", async () => {
    stubFetch(() =>
      jsonResponse(429, { error: { message: "throttled" } }, { "Retry-After": "17" }),
    );
    const error = await provider
      .sendMail("access-1", { to: "t@example.com", subject: "s", bodyText: "b" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphRequestError);
    expect((error as GraphRequestError).status).toBe(429);
    expect((error as GraphRequestError).retryAfterSeconds).toBe(17);
  });

  it("maps Graph 401 to ReauthRequiredError", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: "InvalidAuthenticationToken" } }));
    await expect(provider.getProfile("expired")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("other failures throw GraphRequestError with the status", async () => {
    stubFetch(() => jsonResponse(500, { error: { message: "boom" } }));
    const error = await provider.getProfile("x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphRequestError);
    expect((error as GraphRequestError).status).toBe(500);
  });

  it("never leaks the access token or Microsoft body text into error messages", async () => {
    stubFetch(() => jsonResponse(500, { error: { message: "secret-internal-detail" } }));
    const error = (await provider
      .getProfile("super-secret-access-token")
      .catch((caught: unknown) => caught)) as GraphRequestError;
    expect(error.message).not.toContain("super-secret-access-token");
    expect(error.message).not.toContain("secret-internal-detail");
  });
});

/**
 * Defect F3 (found on live staging 2026-07-30): every Graph 401 was mapped to
 * ReauthRequiredError, so an account with no Exchange licence was told
 * "Microsoft authorisation expired — reconnect the mailbox". Reconnecting can
 * never help — the grant is perfectly valid, the account simply has no mailbox —
 * so the user loops forever. Observed on
 * evatest@evacrosstenanttest.onmicrosoft.com, which has no Exchange licence.
 */
describe("GraphMailProvider — a missing mailbox is not an expired grant (F3)", () => {
  const provider = new GraphMailProvider(ENV);

  const mailboxless = (code: string) =>
    jsonResponse(401, { error: { code, message: "confidential-microsoft-detail" } });

  it("maps a 401 MailboxNotEnabledForRESTAPI to MailboxUnavailableError", async () => {
    stubFetch(() => mailboxless("MailboxNotEnabledForRESTAPI"));
    await expect(provider.getProfile("valid-token")).rejects.toBeInstanceOf(
      MailboxUnavailableError,
    );
  });

  it("maps the other mailbox-missing codes Graph uses", async () => {
    for (const code of ["MailboxNotHostedInExchangeOnline", "RestApiNotEnabledForUser"]) {
      stubFetch(() => mailboxless(code));
      await expect(provider.getProfile("valid-token")).rejects.toBeInstanceOf(
        MailboxUnavailableError,
      );
    }
  });

  it("matches the code case-insensitively", async () => {
    stubFetch(() => mailboxless("mailboxnotenabledforrestapi"));
    await expect(provider.getProfile("valid-token")).rejects.toBeInstanceOf(
      MailboxUnavailableError,
    );
  });

  it("still treats every other 401 as a dead grant", async () => {
    stubFetch(() => mailboxless("InvalidAuthenticationToken"));
    await expect(provider.getProfile("expired")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("falls back to a dead grant when the 401 body is unreadable", async () => {
    // Safe default: an unparseable body must not become "you have no mailbox",
    // which would tell a user with a perfectly good mailbox to go and buy one.
    stubFetch(() => new Response("<html>401</html>", { status: 401 }));
    await expect(provider.getProfile("expired")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("does not echo Microsoft's body text (the no-echo rule still holds)", async () => {
    stubFetch(() => mailboxless("MailboxNotEnabledForRESTAPI"));
    const error = (await provider
      .getProfile("super-secret-access-token")
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("confidential-microsoft-detail");
    expect(error.message).not.toContain("super-secret-access-token");
  });

  it("probeMailbox resolves for an account that has one", async () => {
    stubFetch((url) => {
      expect(url).toContain("https://graph.microsoft.com/v1.0/me/mailFolders/inbox");
      return jsonResponse(200, { id: "inbox-id" });
    });
    await expect(provider.probeMailbox("valid-token")).resolves.toBeUndefined();
  });

  it("probeMailbox surfaces MailboxUnavailableError so connect can refuse early", async () => {
    stubFetch(() => mailboxless("MailboxNotEnabledForRESTAPI"));
    await expect(provider.probeMailbox("valid-token")).rejects.toBeInstanceOf(
      MailboxUnavailableError,
    );
  });
});

/**
 * Defect F5 (found on live staging 2026-07-30): the authorize URL set neither
 * `login_hint` nor `prompt`, so Microsoft silently reused whatever session
 * existed. Someone signed into a personal and a work account got no choice and
 * could connect the WRONG mailbox without ever seeing a picker — after which
 * Eva chases their customers from an address they never intended to use.
 */
describe("GraphMailProvider — account targeting on the authorize URL (F5)", () => {
  const provider = new GraphMailProvider(ENV);

  it("passes login_hint through when the user told us their address", () => {
    const url = new URL(provider.buildAuthorizeUrl("state-xyz", { loginHint: "sara@example.com" }));
    expect(url.searchParams.get("login_hint")).toBe("sara@example.com");
  });

  it("omits login_hint entirely when we do not have one", () => {
    const url = new URL(provider.buildAuthorizeUrl("state-xyz"));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it("always asks for the account picker", () => {
    // Belt and braces only: prompt=select_account was IGNORED once a session
    // context existed (Microsoft's reprocess flow, observed 2026-07-30), so
    // nothing may depend on it. login_hint is the reliable mechanism, and
    // showing the connected address back to the user is the real guarantee.
    const url = new URL(provider.buildAuthorizeUrl("state-xyz"));
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("keeps the state and scopes untouched", () => {
    const url = new URL(provider.buildAuthorizeUrl("state-xyz", { loginHint: "sara@example.com" }));
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read Mail.Send");
  });
});
