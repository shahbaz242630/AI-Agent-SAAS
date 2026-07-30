import * as Sentry from "@sentry/nestjs";
import type { ApiEnv } from "../../config/env.js";
import { isCredentialQueryUrl, stripCredentialQuery } from "../logging/log-redaction.js";
import type { ErrorReporter } from "./error-reporter.js";

/**
 * Strips request bodies from every event, plus the query string on
 * credential-bearing routes (Slice 1.6, BRD 14).
 *
 * The query matters because `sendDefaultPii: false` does NOT suppress it:
 * Sentry's requestData integration always attaches `request.url` and includes
 * `query_string` unless `urlQueryParams` is explicitly disabled, and its PII
 * deny-list only covers header snippets — never `code` or `state`. So without
 * this, roughly one in ten sampled TRANSACTIONS on the OAuth callback would
 * ship a live authorization code to Sentry, with no error required.
 */
function scrubEvent<T extends Sentry.Event>(event: T): T {
  if (!event.request) return event;
  // Never send HTTP request bodies — they can contain contact details.
  delete event.request.data;
  if (typeof event.request.url === "string" && isCredentialQueryUrl(event.request.url)) {
    event.request.url = stripCredentialQuery(event.request.url);
    delete event.request.query_string;
  }
  return event;
}

/**
 * Sentry initialisation for the API (BRD 14). Deliberately conservative on
 * PII: no default PII (no user/IP attachment), request bodies are stripped
 * before events leave the process, and OAuth query strings are scrubbed from
 * both error and transaction events — contact details and credentials must not
 * reach Sentry. Tracing stays on at a 10% sample rate for the BRD 14
 * request-duration baseline; Logs/Profiling/Replay stay OFF (founder decision
 * 2026-07-22).
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
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  });
}

/** ErrorReporter backed by Sentry; safe to call even when init was skipped. */
export const sentryErrorReporter: ErrorReporter = {
  captureException(error, context) {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  },
};
