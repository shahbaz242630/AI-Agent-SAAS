import * as Sentry from "@sentry/nextjs";

/**
 * Browser-side Sentry initialisation (BRD 14). Privacy posture matches the
 * API/worker: no default PII (no user/IP attachment), session replay stays
 * OFF, and no request/response bodies are attached to events. Tracing runs
 * at a 10% sample rate for the BRD 14 performance baseline.
 *
 * The DSN is bridged from SENTRY_DSN_WEB to NEXT_PUBLIC_SENTRY_DSN in
 * next.config.ts. Disabled when the DSN is empty, and ALWAYS in tests.
 */
if (process.env.NODE_ENV !== "test" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Never send HTTP request bodies — they can contain contact details.
      if (event.request) {
        delete event.request.data;
      }
      return event;
    },
  });
}

// Instruments App Router navigations for tracing; a no-op when not init'd.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
