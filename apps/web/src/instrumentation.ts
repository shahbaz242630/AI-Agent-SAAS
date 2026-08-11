import * as Sentry from "@sentry/nextjs";
import { configuredOrigin, MISSING_ORIGIN_MESSAGE } from "./lib/public-origin";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    assertPublicOriginConfigured();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * ⚠️ THE SERVER REFUSES TO START WITHOUT ITS OWN ADDRESS.
 *
 * Every link Eva emails is built from `WEB_PUBLIC_ORIGIN`. Unset, the only
 * honest options are to stop or to guess, and guessing is precisely what
 * produced two dead-link defects on consecutive days: #79 (a missing redirect
 * option falling back to the marketing page) and the `https://localhost:8080`
 * confirmations on 2026-08-11. A deploy that stops costs minutes; a deploy that
 * guesses costs every customer who signs up before somebody clicks a link.
 *
 * Skipped during `next build`, which renders pages without ever serving a
 * request and legitimately runs with no runtime configuration.
 */
function assertPublicOriginConfigured(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (configuredOrigin()) return;
  throw new Error(MISSING_ORIGIN_MESSAGE);
}

// Captures errors from Server Components, route handlers and middleware.
// A no-op when Sentry was not initialised (empty DSN or tests).
export const onRequestError = Sentry.captureRequestError;
