import { Writable } from "node:stream";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";
import { LOG_REDACT_PATHS } from "../src/common/logging/log-redaction.js";

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
});
