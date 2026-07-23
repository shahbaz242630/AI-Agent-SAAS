import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../src/config/env.js";

// The Sentry SDK is an external boundary — unit tests must never let events
// leave CI, so the SDK module is replaced with spies.
vi.mock("@sentry/nestjs", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

import * as Sentry from "@sentry/nestjs";
import { initSentry, sentryErrorReporter } from "../src/common/monitoring/sentry.js";

const baseEnv: ApiEnv = {
  NODE_ENV: "production",
  PORT: 3001,
  LOG_LEVEL: "info",
  WEB_ORIGIN: "https://app.eva.example",
  SUPABASE_URL: "https://test.supabase.local",
  SUPABASE_ANON_KEY: "",
  APP_DATABASE_URL: "postgresql://eva_app:eva_app@localhost:5432/eva",
  SENTRY_DSN_API: "https://public@o0.ingest.de.sentry.io/0",
};

describe("initSentry (BRD 14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not initialise Sentry when no DSN is configured", () => {
    initSentry({ ...baseEnv, SENTRY_DSN_API: "" });

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("never initialises Sentry in the test environment — no events leave CI", () => {
    initSentry({ ...baseEnv, NODE_ENV: "test" });

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initialises with PII-safe options and 10% trace sampling when configured", () => {
    initSentry(baseEnv);

    expect(Sentry.init).toHaveBeenCalledOnce();
    const options = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      dsn: baseEnv.SENTRY_DSN_API,
      environment: "production",
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
    });
  });

  it("strips request bodies from events before they are sent", () => {
    initSentry(baseEnv);
    const options = vi.mocked(Sentry.init).mock.calls[0]?.[0];

    const event = {
      request: { data: "email=customer@example.com", headers: { "content-type": "text/plain" } },
    };
    const scrubbed = options?.beforeSend?.(event as never, {} as never);

    expect(JSON.stringify(scrubbed)).not.toContain("customer@example.com");
  });
});

describe("sentryErrorReporter", () => {
  it("forwards captured exceptions with context to Sentry", () => {
    const error = new Error("boom");

    sentryErrorReporter.captureException(error, { correlationId: "corr-1" });

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      extra: { correlationId: "corr-1" },
    });
  });
});
