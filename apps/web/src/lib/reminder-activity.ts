import type {
  ReminderActivityDto,
  ReminderStepKey,
  ReminderWaitingReason,
  ScheduledActionStatus,
} from "@eva/types";

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
      fixHref: "/app/settings/mailbox",
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

/**
 * The one-line summary at the top.
 *
 * "Nothing yet" is a real answer and must not read as an error: a new customer
 * with no overdue invoices is the healthiest possible state, and telling them
 * something looks wrong would be a lie.
 */
export function summarise(counts: ReminderActivityDto["counts"]): string {
  if (counts.sentLast7Days === 0 && counts.waiting === 0 && counts.failedLast7Days === 0) {
    return "Eva hasn't needed to chase anyone in the last week.";
  }
  const sent =
    counts.sentLast7Days === 1 ? "1 reminder sent" : `${counts.sentLast7Days} reminders sent`;
  return `${sent} in the last 7 days.`;
}
