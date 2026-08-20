/**
 * Error-reporting port (BRD 14). The global exception filter reports 5xx
 * faults here; the Sentry integration (Slice 0.4) provides the production
 * implementation. Kept behind a token so the filter has no SDK dependency and
 * tests inject a spy.
 */
export const ERROR_REPORTER = Symbol("ERROR_REPORTER");

/**
 * ⚠️ TAGS AND EXTRA ARE NOT TWO NAMES FOR THE SAME THING, AND PUTTING A VALUE
 * IN THE WRONG ONE MAKES IT UNFINDABLE. Sentry indexes tags: they are what a
 * search box, a filter and an alert can use. `extra` is only visible once you
 * have already found the event — which is no help at all when the question is
 * "show me everything invoice follow-up broke this week", or when a customer
 * quotes a reference number and there are nine thousand events to look in.
 *
 * Until 2026-08-20 everything went into `extra`, including the correlation id
 * the customer reads off their own screen.
 */
export interface FaultContext {
  /** Indexed and searchable. Short, low-noise values only — a product tag, a
   *  correlation id; never a message or a stack. */
  tags?: Record<string, string>;
  /** Visible on the event, not searchable. Everything else. */
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  captureException(error: unknown, context?: FaultContext): void;
}
