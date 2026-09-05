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
  INTERNAL_API_SECRET: "test-internal-secret-0123456789abcdef", // gitleaks:allow — fake test fixture
  TOKEN_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  OAUTH_STATE_SECRET: "test-oauth-state-secret-0123456789abcdef", // gitleaks:allow — fake test fixture
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret", // gitleaks:allow — fake test fixture
  MICROSOFT_TENANT: "common",
  MICROSOFT_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/microsoft/callback",
  INBOUND_EMAIL_DOMAIN: "",
  RESEND_API_KEY: "",
  RESEND_WEBHOOK_SECRET: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/google/callback",
  // Slice 3.2c. Empty on purpose: the WhatsApp guard must refuse everything
  // when unconfigured, and these fixtures are where that state is exercised.
  META_APP_ID: "",
  META_APP_SECRET: "",
  WHATSAPP_VERIFY_TOKEN: "",
  WHATSAPP_ACCESS_TOKEN: "",
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
  /**
   * ⚠️ THE SPLIT IS THE POINT. Sentry indexes tags and does not index `extra`,
   * so a value in the wrong one is a value nobody can search for. Until
   * 2026-08-20 everything went to `extra`, including the reference number the
   * customer reads off their own error screen.
   */
  it("forwards tags as tags and extra as extra", () => {
    const error = new Error("boom");

    sentryErrorReporter.captureException(error, {
      tags: { product: "product:invoice-follow-up", correlationId: "corr-1" },
      extra: { path: "/organisations/1/invoices" },
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { product: "product:invoice-follow-up", correlationId: "corr-1" },
      extra: { path: "/organisations/1/invoices" },
    });
  });

  it("passes no hint at all when there is no context, rather than an empty one", () => {
    const error = new Error("boom");

    sentryErrorReporter.captureException(error);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
