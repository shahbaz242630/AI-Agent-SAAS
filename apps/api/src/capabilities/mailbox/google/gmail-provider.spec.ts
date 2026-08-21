import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { MailProviderRequestError, ReauthRequiredError } from "../mail-provider.js";
import { GmailProvider } from "./gmail-provider.js";

/**
 * The hand-rolled Gmail client (Slice 3.1b, step 3). `fetch` is stubbed
 * throughout — no network and no Google Cloud project needed, so the build
 * never waits on the founder's console work.
 *
 * ⚠️ EVERY BEHAVIOUR ASSERTED HERE WAS READ OUT OF GOOGLE'S DOCUMENTATION ON
 * 2026-08-21, NOT REMEMBERED. That is a deliberate reaction to what happened
 * hours earlier the same day: the first real inbound email arrived without the
 * sender's name because the fixtures and the code had been invented by the same
 * author, so 881 tests agreed with each other and with nothing else.
 */

const ENV = {
  GOOGLE_CLIENT_ID: "client-id-123.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret-abc", // gitleaks:allow — fake test fixture
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/google/callback",
} as ApiEnv;

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
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

describe("GmailProvider: the authorize URL", () => {
  const provider = new GmailProvider(ENV);

  /**
   * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE. Google returns a refresh token
   * ONLY when `access_type=offline` is set, and on a SECOND authorisation by
   * the same user it returns none at all unless the consent screen is forced
   * with `prompt=consent`.
   *
   * That second case IS the reconnect path — and while the OAuth app is in
   * Testing status Google expires the grant every seven days, so every test
   * user walks it weekly. Lose either parameter and a reconnect appears to
   * succeed, works for one hour, and dies. Nothing logs an error.
   */
  it("asks for offline access and forces consent, so a reconnect still yields a refresh token", () => {
    const url = new URL(provider.buildAuthorizeUrl("state-xyz"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("targets Google's v2 authorize endpoint with our client and redirect", () => {
    const url = new URL(provider.buildAuthorizeUrl("state-xyz"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(ENV.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.GOOGLE_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });

  /**
   * ⚠️ RULING 25, ENFORCED BY A TEST RATHER THAN BY MEMORY. Every scope that
   * can READ a Gmail inbox — including `gmail.metadata`, which sees only sender
   * and subject — is RESTRICTED on Google's own classification: a security
   * assessment every twelve months, weeks of waiting, and a 100-user cap until
   * it clears. `gmail.send` is merely sensitive: one review, no audit, no fee.
   *
   * Adding one of these would be a recurring bill nobody would notice until
   * Google asked for it.
   */
  it("asks for gmail.send and no scope that can read a mailbox", () => {
    const scope = new URL(provider.buildAuthorizeUrl("s")).searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/gmail.send");
    for (const restricted of [
      "gmail.readonly",
      "gmail.modify",
      "gmail.metadata",
      "gmail.compose",
      "https://mail.google.com/",
    ]) {
      expect(scope, `${restricted} is a restricted scope and costs an annual audit`).not.toContain(
        restricted,
      );
    }
  });

  it("passes a login hint so somebody in two accounts lands on the right one", () => {
    const url = new URL(provider.buildAuthorizeUrl("s", { loginHint: "jane@example.com" }));
    expect(url.searchParams.get("login_hint")).toBe("jane@example.com");
  });
});

describe("GmailProvider: tokens", () => {
  const provider = new GmailProvider(ENV);

  it("exchanges a code for a token pair", async () => {
    stubFetch((url) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      return jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/gmail.send openid",
      });
    });
    await expect(provider.exchangeCode("code-1")).resolves.toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresInSeconds: 3599,
      scopes: ["https://www.googleapis.com/auth/gmail.send", "openid"],
    });
  });

  /**
   * ⚠️ GOOGLE DOES NOT RETURN A REFRESH TOKEN WHEN REFRESHING, AND THAT IS
   * NORMAL. Microsoft rotates them on every refresh, so its adapter treats a
   * missing one as a fault. Applying that rule here would fail EVERY renewal —
   * meaning every Gmail mailbox would work for one hour after connecting and
   * then report itself broken forever.
   */
  it("keeps the existing refresh token when Google returns only an access token", async () => {
    stubFetch(() => jsonResponse(200, { access_token: "at-2", expires_in: 3599, scope: "" }));
    await expect(provider.refreshTokens("rt-original")).resolves.toEqual({
      accessToken: "at-2",
      refreshToken: "rt-original",
      expiresInSeconds: 3599,
      scopes: [],
    });
  });

  it("takes a rotated refresh token when Google does send one", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        access_token: "at-3",
        refresh_token: "rt-new",
        expires_in: 60,
        scope: "",
      }),
    );
    const tokens = await provider.refreshTokens("rt-original");
    expect(tokens.refreshToken).toBe("rt-new");
  });

  /**
   * ⚠️ A MISSING REFRESH TOKEN ON AN *EXCHANGE* IS A MISCONFIGURATION, NOT A
   * QUIRK — it means the authorize URL lost `access_type=offline` or
   * `prompt=consent`. Storing the connection anyway hands the customer a
   * mailbox with a one-hour life. Fail while somebody is watching the screen.
   */
  it("refuses to complete a connection that came back with no refresh token", async () => {
    stubFetch(() => jsonResponse(200, { access_token: "at-4", expires_in: 3599 }));
    await expect(provider.exchangeCode("code-1")).rejects.toThrow(/no refresh token/i);
  });

  it("maps invalid_grant to a reconnect, not to a retry", async () => {
    stubFetch(() => jsonResponse(400, { error: "invalid_grant" }));
    await expect(provider.refreshTokens("dead")).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(provider.exchangeCode("used-already")).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  /** Google's error bodies quote request material back, and this string is logged. */
  it("reports the status without echoing Google's error body", async () => {
    stubFetch(() => jsonResponse(500, { error: "boom", error_description: "code=SECRET-ish" }));
    await expect(provider.exchangeCode("c")).rejects.toThrow(
      "Google token endpoint rejected the request",
    );
    await expect(provider.exchangeCode("c")).rejects.not.toThrow(/SECRET-ish/);
  });
});

describe("GmailProvider: sending", () => {
  const provider = new GmailProvider(ENV);

  it("posts a base64url message to the Gmail send endpoint", async () => {
    let sentRaw = "";
    stubFetch((url, init) => {
      expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      expect(init.method).toBe("POST");
      sentRaw = (JSON.parse(String(init.body)) as { raw: string }).raw;
      return jsonResponse(200, { id: "msg-1" });
    });

    await provider.sendMail("at-1", {
      from: "eva@example.com",
      to: "debtor@example.com",
      subject: "Invoice 42",
      bodyText: "Please pay.",
    });

    // base64url: no +, / or = anywhere.
    expect(sentRaw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(sentRaw, "base64url").toString("utf8");
    expect(decoded).toContain("From: eva@example.com");
    expect(decoded).toContain("To: debtor@example.com");
    expect(decoded).toContain("Subject: Invoice 42");
  });

  /**
   * ⚠️ ONE ROUND TRIP, NOT TWO. The first cut fetched the profile inside
   * `sendMail` to learn the From address — an extra network call on every
   * email, and one more thing that can fail between a customer's chaser and
   * their debtor. The caller has always had the address to hand.
   */
  it("sends without asking Google who we are", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return jsonResponse(200, { id: "msg-1" });
    });
    await provider.sendMail("at-1", {
      from: "eva@example.com",
      to: "d@e.com",
      subject: "s",
      bodyText: "b",
    });
    expect(calls).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
  });

  it("treats a 401 as a dead grant", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: 401 } }));
    await expect(
      provider.sendMail("stale", { to: "d@e.com", subject: "s", bodyText: "b" }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  /**
   * ⚠️ THE RATE LIMIT MUST STAY RETRYABLE. `outbound-mail.ts` defers on a
   * `MailProviderRequestError` with a transient status; anything else marks the
   * reminder permanently failed. Google rate-limits per user per second, which
   * bites exactly when a customer's book is big.
   */
  it("surfaces a rate limit as retryable, with Google's own Retry-After", async () => {
    stubFetch(() => jsonResponse(429, { error: { code: 429 } }, { "Retry-After": "30" }));
    await expect(
      provider.sendMail("at", { to: "d@e.com", subject: "s", bodyText: "b" }),
    ).rejects.toMatchObject({
      name: "MailProviderRequestError",
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  it("surfaces a Google outage as retryable too", async () => {
    stubFetch(() => jsonResponse(503, {}));
    await expect(
      provider.sendMail("at", { to: "d@e.com", subject: "s", bodyText: "b" }),
    ).rejects.toBeInstanceOf(MailProviderRequestError);
  });
});

describe("GmailProvider: identity and the probe", () => {
  const provider = new GmailProvider(ENV);

  it("reads the connected address from the OpenID userinfo endpoint", async () => {
    stubFetch((url) => {
      expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      return jsonResponse(200, { email: "jane@example.com", name: "Jane Smith" });
    });
    await expect(provider.getProfile("at")).resolves.toEqual({
      emailAddress: "jane@example.com",
      displayName: "Jane Smith",
    });
  });

  it("refuses a profile with no address rather than storing an empty mailbox", async () => {
    stubFetch(() => jsonResponse(200, { name: "Nameless" }));
    await expect(provider.getProfile("at")).rejects.toThrow(/no email address/i);
  });

  /**
   * ⚠️ A NO-OP ON PURPOSE, AND THE HONEST REASON IS THAT WE CANNOT ASK.
   * Microsoft's probe reads the inbox folder to catch a licence-less account at
   * connect time (defect F3). Gmail's equivalent, `users.getProfile`, needs a
   * RESTRICTED scope — an annual audit to check a licence is the wrong trade.
   *
   * The welcome test email sent straight after connecting covers it instead: a
   * Workspace account with Gmail switched off fails there, while the customer
   * is still watching. Resolving is correct — pretending to have checked would
   * be worse than not checking.
   */
  it("does not pretend to have checked something it cannot see", async () => {
    stubFetch(() => {
      throw new Error("probeMailbox must not call Google");
    });
    await expect(provider.probeMailbox()).resolves.toBeUndefined();
  });
});
