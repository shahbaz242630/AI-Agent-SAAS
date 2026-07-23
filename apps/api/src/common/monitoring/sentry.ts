import * as Sentry from "@sentry/nestjs";
import type { ApiEnv } from "../../config/env.js";
import type { ErrorReporter } from "./error-reporter.js";

/**
 * Sentry initialisation for the API (BRD 14). Deliberately conservative on
 * PII: no default PII (no user/IP attachment) and request bodies are stripped
 * before events leave the process — contact details must not reach Sentry.
 * Tracing stays on at a 10% sample rate for the BRD 14 request-duration
 * baseline; Logs/Profiling/Replay stay OFF (founder decision 2026-07-22).
 *
 * Disabled when no DSN is configured, and ALWAYS in tests — no events leave CI.
 */
export function initSentry(env: ApiEnv): void {
  if (env.NODE_ENV === "test" || env.SENTRY_DSN_API.length === 0) {
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN_API,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend(event) {
      // Never send HTTP request bodies — they can contain contact details.
      if (event.request) {
        delete event.request.data;
      }
      return event;
    },
  });
}

/** ErrorReporter backed by Sentry; safe to call even when init was skipped. */
export const sentryErrorReporter: ErrorReporter = {
  captureException(error, context) {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  },
};
