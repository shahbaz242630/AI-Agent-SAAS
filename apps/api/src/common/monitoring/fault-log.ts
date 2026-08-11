/**
 * Fault-logging port — the line an operator greps, as opposed to the incident
 * an operator triages.
 *
 * ⚠️ SEPARATE FROM `ERROR_REPORTER` ON PURPOSE, AND 2026-08-11 IS WHY. Sentry
 * had the fault. The Railway deploy log — the thing being read at the time,
 * beside the failing request, by someone watching a founder unable to load
 * their own dashboard — said `request errored` and nothing else. Two
 * destinations, two questions: "what is broken this week" and "why did THAT
 * request fail". Reporting to one and calling it observability is how an hour
 * disappears.
 *
 * Behind a token for the same reason as the reporter: the filter keeps no
 * logging SDK of its own, and a test can hold the exact entry that was written
 * rather than scraping stdout.
 */
export const FAULT_LOG = Symbol("FAULT_LOG");

export interface FaultLog {
  recordFault(entry: Record<string, unknown>): void;
}
