import * as Sentry from "@sentry/nextjs";

/**
 * Server-side (Node.js runtime) Sentry initialisation for the web app
 * (BRD 14). Privacy posture matches the API: sendDefaultPii false, request
 * bodies stripped, tracing at 10%. Disabled when the DSN is empty, and
 * ALWAYS in tests.
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
