import { Writable } from "node:stream";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  isCredentialQueryUrl,
  LOG_REDACT_PATHS,
  serializeRequest,
  stripCredentialQuery,
} from "../src/common/logging/log-redaction.js";

/**
 * PII-in-logs guard (BRD 14, Slice 0.4): credentials, tokens and personal
 * contact details must never reach the structured logs. This builds a real
 * pino logger with the production redaction config and asserts the values
 * are scrubbed at every nesting depth the API actually logs.
 */
describe("log redaction (BRD 14)", () => {
  function captureLogger(): { logger: Logger; output: () => string } {
    let buffer = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        buffer += String(chunk);
        callback();
      },
    });
    return { logger: pino({ redact: LOG_REDACT_PATHS }, stream), output: () => buffer };
  }

  it("redacts authorization and cookie headers on logged requests", async () => {
    const { logger, output } = captureLogger();

    logger.info({
      req: {
        method: "GET",
        url: "/users",
        headers: { authorization: "Bearer secret-token", cookie: "session=abc123" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const logged = output();
    expect(logged).not.toContain("secret-token");
    expect(logged).not.toContain("session=abc123");
    expect(logged).toContain("[Redacted]");
  });

  it("redacts email, phone and credential fields at any logged depth", async () => {
    const { logger, output } = captureLogger();

    logger.info({
      email: "top-level@example.com",
      user: { email: "nested@example.com", phone: "+44 7700 900123" },
      req: { body: { email: "deep@example.com", password: "hunter2", accessToken: "tok_123" } },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const logged = output();
    for (const pii of [
      "top-level@example.com",
      "nested@example.com",
      "+44 7700 900123",
      "deep@example.com",
      "hunter2",
      "tok_123",
    ]) {
      expect(logged).not.toContain(pii);
    }
  });

  it("leaves non-sensitive fields untouched", async () => {
    const { logger, output } = captureLogger();

    logger.info({ organisationId: "org_123", msg: "safe context" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(output()).toContain("org_123");
  });

  /**
   * Slice 1.6: the OAuth callback's query string carries the single-use
   * authorization code and the state JWT. nestjs-pino attaches the serialized
   * req to EVERY line a request emits, so the handler's own info/warn logs
   * would leak them even with autoLogging.ignore set — the serializer is what
   * actually stops it.
   */
  describe("OAuth callback query (Slice 1.6, BRD 14)", () => {
    function fakeRequest(url: string) {
      return {
        id: "req-1",
        method: "GET",
        url,
        headers: { host: "api.eva.local" },
        socket: { remoteAddress: "127.0.0.1", remotePort: 44444 },
      } as unknown as Parameters<typeof serializeRequest>[0];
    }

    it("strips code and state from the callback URL, keeping the path", () => {
      const serialized = serializeRequest(
        fakeRequest(
          "/integrations/microsoft/callback?code=super-secret-code&state=header.body.sig",
        ),
      );
      const logged = JSON.stringify(serialized);
      expect(logged).not.toContain("super-secret-code");
      expect(logged).not.toContain("header.body.sig");
      expect(serialized.url).toBe("/integrations/microsoft/callback");
    });

    it("survives a real pino round-trip on a handler's own log line", async () => {
      const { logger, output } = captureLogger();

      logger.info(
        {
          req: serializeRequest(
            fakeRequest("/integrations/microsoft/callback?code=leaky-code&state=leaky-state"),
          ),
        },
        "mailbox connected",
      );
      await new Promise((resolve) => setImmediate(resolve));

      const logged = output();
      expect(logged).not.toContain("leaky-code");
      expect(logged).not.toContain("leaky-state");
      expect(logged).toContain("/integrations/microsoft/callback");
    });

    it("leaves other routes' query strings intact (debuggability)", () => {
      const serialized = serializeRequest(fakeRequest("/organisations?page=2"));
      expect(serialized.url).toBe("/organisations?page=2");
    });

    /**
     * pino is not the only sink: the exception filter passes a path to Sentry
     * and Sentry's own requestData integration always attaches request.url
     * (query included — `sendDefaultPii: false` does not cover it). All of them
     * share this one rule so the layers cannot drift apart.
     */
    describe("stripCredentialQuery (shared by the Sentry scrubber + exception filter)", () => {
      it("drops the query on the callback path", () => {
        expect(stripCredentialQuery("/integrations/microsoft/callback?code=abc&state=xyz")).toBe(
          "/integrations/microsoft/callback",
        );
      });

      it("handles the absolute URLs Sentry sends", () => {
        expect(
          stripCredentialQuery(
            "https://api-staging-36aaa.up.railway.app/integrations/microsoft/callback?code=abc",
          ),
        ).toBe("/integrations/microsoft/callback");
      });

      it("matches case-insensitively — Express routes that way too", () => {
        expect(stripCredentialQuery("/Integrations/Microsoft/Callback?code=abc")).toBe(
          "/Integrations/Microsoft/Callback",
        );
        expect(isCredentialQueryUrl("/INTEGRATIONS/MICROSOFT/CALLBACK?code=abc")).toBe(true);
      });

      it("leaves ordinary URLs untouched", () => {
        expect(stripCredentialQuery("/organisations?page=2")).toBe("/organisations?page=2");
        expect(isCredentialQueryUrl("/organisations?page=2")).toBe(false);
      });
    });
  });

  /**
   * Meta's webhook verification handshake (slice 3.2c) puts OUR shared secret
   * for the route in the query string: `hub.verify_token`. Same rule, same
   * list, same three sinks as the OAuth callback — and a key with a dot in
   * it, which the key-based `redact` paths could never have named.
   */
  describe("Meta handshake query (Slice 3.2c, BRD 14)", () => {
    const HANDSHAKE =
      "/integrations/meta/webhook?hub.mode=subscribe&hub.verify_token=our-shared-secret&hub.challenge=1234567890";

    function fakeRequest(url: string) {
      return {
        id: "req-2",
        method: "GET",
        url,
        headers: { host: "api.eva.local" },
        socket: { remoteAddress: "127.0.0.1", remotePort: 44445 },
      } as unknown as Parameters<typeof serializeRequest>[0];
    }

    it("strips the verify token from the handshake URL, keeping the path", () => {
      const serialized = serializeRequest(fakeRequest(HANDSHAKE));
      const logged = JSON.stringify(serialized);
      expect(logged).not.toContain("our-shared-secret");
      expect(logged).not.toContain("hub.verify_token");
      expect(serialized.url).toBe("/integrations/meta/webhook");
      expect(serialized.query).toBe("[Redacted]");
    });

    it("survives a real pino round-trip on the controller's own refusal line", async () => {
      const { logger, output } = captureLogger();
      logger.warn(
        {
          req: serializeRequest(fakeRequest(HANDSHAKE)),
          reason: "hub.verify_token does not match",
        },
        "refused a Meta webhook verification handshake",
      );
      await new Promise((resolve) => setImmediate(resolve));
      const logged = output();
      expect(logged).not.toContain("our-shared-secret");
      expect(logged).toContain("/integrations/meta/webhook");
    });

    it("is dropped by the shared helper too, absolute URLs and odd casing included", () => {
      expect(stripCredentialQuery(HANDSHAKE)).toBe("/integrations/meta/webhook");
      expect(stripCredentialQuery(`https://api-production-0e01.up.railway.app${HANDSHAKE}`)).toBe(
        "/integrations/meta/webhook",
      );
      expect(isCredentialQueryUrl("/Integrations/Meta/Webhook?hub.verify_token=x")).toBe(true);
    });

    /**
     * ⚠️ THE CASE THAT MUST FAIL. The rule is keyed by the exact path: a
     * near-miss is left alone, which is what a mistyped entry in the list
     * would amount to — the token in the log, and every test above still
     * green if it only asserted on the matching path.
     */
    it("does not fire on a near-miss path — the match is exact", () => {
      const nearMiss = "/integrations/meta/webhooks?hub.verify_token=would-leak";
      expect(isCredentialQueryUrl(nearMiss)).toBe(false);
      expect(serializeRequest(fakeRequest(nearMiss)).url).toBe(nearMiss);
    });
  });
});
