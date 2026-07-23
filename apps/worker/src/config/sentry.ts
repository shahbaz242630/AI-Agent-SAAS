import * as Sentry from "@sentry/node";
import type { WorkerEnv } from "./env.js";

/**
 * Sentry initialisation for the worker (BRD 14). PII-conservative: no default
 * PII attachment. Disabled when no DSN is configured, and ALWAYS in tests —
 * no events leave CI.
 */
export function initSentry(env: WorkerEnv): void {
  if (env.NODE_ENV === "test" || !env.SENTRY_DSN_WORKER) {
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN_WORKER,
    environment: env.NODE_ENV,
    sendDefaultPii: false,
  });
}
