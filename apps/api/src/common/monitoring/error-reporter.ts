/**
 * Error-reporting port (BRD 14). The global exception filter reports 5xx
 * faults here; the Sentry integration (Slice 0.4) provides the production
 * implementation. Kept behind a token so the filter has no SDK dependency and
 * tests inject a spy.
 */
export const ERROR_REPORTER = Symbol("ERROR_REPORTER");

export interface ErrorReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
}
