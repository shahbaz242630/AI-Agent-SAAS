import { moduleHref } from "@eva/types";
import type { ReminderStepKey, ReminderWaitingReason, ScheduledActionStatus } from "@eva/types";

/**
 * How the chase activity screen reads (Slice 1.7).
 *
 * Pure presentation, kept out of the page so it can be tested — every web test
 * in this repo is a unit test of a `lib` function, and the alternative here
 * would be untested strings that decide whether a customer understands why
 * nothing has been sent.
 *
 * ⚠️ These are LABELS ONLY. Nothing here decides what happened; the API
 * derives status and the waiting reason. A second opinion computed in the
 * browser is how `apps/web`'s state-machine mirror went stale within an hour.
 */

/** What each stage is, in the language a customer would use. */
const STAGE_LABELS: Record<ReminderStepKey, string> = {
  pre_due_3: "Before due",
  due_date: "On the due date",
  overdue_7: "First chase",
  overdue_14: "Second chase",
  overdue_30: "Final reminder",
  final_escalation: "Handed to you",
};

export function stageLabel(key: ReminderStepKey): string {
  return STAGE_LABELS[key] ?? "Reminder";
}

/**
 * Status in plain English.
 *
 * `ready` deliberately reads "Waiting" rather than "Ready" or "Pending": by the
 * time a row is on this screen it is due, so "ready" would tell a customer
 * everything is fine when in fact nothing has gone out.
 */
const STATUS_LABELS: Record<string, string> = {
  sent: "Sent",
  ready: "Waiting",
  claimed: "Sending",
  failed: "Didn't send",
  pending: "Scheduled",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function statusLabel(status: ScheduledActionStatus | string): string {
  return STATUS_LABELS[status] ?? "Unknown";
}

/** Drives the colour of the status pill; never the meaning. */
export function statusTone(
  status: ScheduledActionStatus | string,
): "good" | "warn" | "bad" | "mute" {
  if (status === "sent") return "good";
  if (status === "ready" || status === "claimed") return "warn";
  if (status === "failed") return "bad";
  return "mute";
}

export interface WaitingExplanation {
  headline: string;
  detail: string;
  /** Where the customer goes to fix it, when there is such a place. */
  fixHref: string | null;
  fixLabel: string | null;
}

/**
 * Why nothing is going out, said in a way that leads somewhere.
 *
 * ⚠️ The honest bit is `unknown`. Eva cannot always tell a customer why — a
 * rate limit or a provider blip is real but invisible — and inventing a
 * confident cause would send them to fix a mailbox that is working. Saying
 * "these will go out on the next run" is both true and the correct advice.
 */
export function explainWaiting(
  waiting: number,
  reason: ReminderWaitingReason | null,
): WaitingExplanation | null {
  if (waiting <= 0 || reason === null) return null;

  const count = waiting === 1 ? "1 reminder is" : `${waiting} reminders are`;

  if (reason === "no_working_mailbox") {
    return {
      headline: `${count} waiting because no mailbox is connected`,
      detail:
        "Eva has nowhere to send from, so nothing has gone out. Nothing is lost — connect a mailbox and these send on the next run.",
      fixHref: moduleHref("email_credit_controller", "mailbox"),
      fixLabel: "Connect a mailbox",
    };
  }

  return {
    headline: `${count} waiting`,
    detail:
      "Eva could not send these on the last run. Nothing is lost — they will be tried again on the next one.",
    fixHref: null,
    fixLabel: null,
  };
}

export interface HistoryEmptyState {
  headline: string;
  detail: string;
}

/**
 * What to say when Eva has not written to anybody YET.
 *
 * ⚠️ THE OLD COPY WAS A FLAT LIE FOR EVERY NEW CUSTOMER (found by walking,
 * 2026-08-18). It read "Nothing is wrong — Eva simply has not needed to write
 * to anybody", unconditionally, while six reminders sat scheduled in the
 * database for an invoice worth £45,711. "Has not needed to" and "is not due
 * yet" are different statements, and only one of them was true.
 *
 * Three genuinely different situations, and the screen must tell them apart:
 *
 * - **Nothing scheduled at all.** The old sentence, and now it is accurate:
 *   there is no plan because nothing needs one.
 * - **Something scheduled, and we can send it.** Say when the first one goes.
 *   That is the whole answer to "is this thing actually working?".
 * - **Something scheduled and nowhere to send from.** Say that FIRST. A date
 *   we cannot keep is worse than no date, and it is the one case with an
 *   action attached.
 */
export function describeNoHistoryYet(input: {
  scheduled: number;
  noWorkingMailbox: boolean;
  /** The soonest upcoming reminder's date, `YYYY-MM-DD`; null when none. */
  nextDate: string | null;
  /** Formats a calendar date for display — passed in, never re-derived here. */
  formatDate: (isoDate: string) => string;
}): HistoryEmptyState {
  if (input.scheduled === 0 || input.nextDate === null) {
    return {
      headline: "Nothing to show yet.",
      detail:
        "Reminders appear here once an invoice is overdue enough to chase. Nothing is wrong — Eva simply has not needed to write to anybody.",
    };
  }

  const count = input.scheduled === 1 ? "1 reminder is" : `${input.scheduled} reminders are`;
  const when = input.formatDate(input.nextDate);

  if (input.noWorkingMailbox) {
    return {
      headline: "Nothing has gone out — there is nowhere to send from.",
      detail: `${count} lined up, the first on ${when}, but no mailbox is connected. Nothing is lost — connect one and they go on the next run.`,
    };
  }

  return {
    headline: "Nothing has gone out yet.",
    detail: `That is because nothing is due. ${count} lined up, starting on ${when}.`,
  };
}
