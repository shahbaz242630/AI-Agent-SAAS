import * as Sentry from "@sentry/nextjs";

/**
 * Edge-runtime Sentry initialisation (BRD 14). Same privacy posture as the
 * server config: sendDefaultPii false, request bodies stripped, tracing at
 * 10%. Disabled when the DSN is empty, and ALWAYS in tests.
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
