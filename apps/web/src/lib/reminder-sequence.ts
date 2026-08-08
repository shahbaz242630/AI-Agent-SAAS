import type { ReminderStepKey } from "@eva/types";

/**
 * How the reminder-timing settings screen reads and does its arithmetic
 * (Slice 1.8; founder ruling 2026-08-08 — "first reminder 3 days before due
 * date, user should have option to change this").
 *
 * Pure, and kept out of the page so it can be tested — the repo's convention,
 * and here the untested thing would be a sign conversion that decides whether a
 * customer is chased three days EARLY or three days LATE.
 *
 * ⚠️ THE STORED VALUE IS SIGNED; THE SCREEN NEVER SHOWS A MINUS SIGN.
 * `offsetDays` is days relative to the invoice due date and negative means
 * before it (`DEFAULT_REMINDER_STEPS` in `@eva/types`). Asking a non-technical
 * user to type `-3` is asking them to get it wrong, so the form is a direction
 * plus a positive number and the conversion lives here.
 */

/**
 * The API's own bounds (`updateReminderStepSchema` in `@eva/validation`:
 * `.min(-30).max(90)`), mirrored so the form can refuse before a round trip.
 *
 * ⚠️ THESE MIRROR THE API AND WILL GO STALE THE WAY THE STATE-MACHINE MIRROR
 * DID. A test asserts a rejection at each edge, so widening the API's range
 * without widening these fails the suite rather than silently keeping the old
 * limit in the browser.
 */
export const MIN_OFFSET_DAYS = -30;
export const MAX_OFFSET_DAYS = 90;

/**
 * The scheduler pushes reminders apart so two never land within three days of
 * each other (`reminder-scheduler.ts`, the spacing pass). Stated on the screen
 * because otherwise a customer who sets two steps one day apart sees Eva
 * silently do something else and concludes the setting is broken.
 */
export const MIN_DAYS_BETWEEN_REMINDERS = 3;

export type OffsetDirection = "before" | "on" | "after";

export interface OffsetParts {
  direction: OffsetDirection;
  /** Always positive — the sign lives in `direction`. */
  days: number;
}

/** Stored signed offset → what the form shows. */
export function splitOffset(offsetDays: number): OffsetParts {
  if (offsetDays === 0) return { direction: "on", days: 0 };
  if (offsetDays < 0) return { direction: "before", days: Math.abs(offsetDays) };
  return { direction: "after", days: offsetDays };
}

/**
 * What the form shows → the stored signed offset.
 *
 * Zero days is the due date whichever direction is selected: "0 days before the
 * due date" and "on the due date" are the same day, and refusing the first
 * would be pedantry a customer has to decode.
 */
export function toOffsetDays(direction: OffsetDirection, days: number): number {
  if (direction === "on" || days === 0) return 0;
  return direction === "before" ? -days : days;
}

/** The stored offset in a sentence, e.g. "3 days before the due date". */
export function describeOffset(offsetDays: number): string {
  if (offsetDays === 0) return "On the due date";
  const { direction, days } = splitOffset(offsetDays);
  const unit = days === 1 ? "day" : "days";
  return `${days} ${unit} ${direction} the due date`;
}

/**
 * Refuse impossible timings before asking the API.
 *
 * Returns the sentence to show, or null when the value is fine. The messages
 * say what the limit IS, not merely that one was hit — "out of range" leaves a
 * customer guessing at the number.
 */
export function validateOffset(direction: OffsetDirection, days: number): string | null {
  if (!Number.isInteger(days)) return "Enter a whole number of days.";
  if (days < 0)
    return "Enter a number of days, without a minus sign — use Before or After instead.";

  const offsetDays = toOffsetDays(direction, days);
  if (offsetDays < MIN_OFFSET_DAYS) {
    return `Eva can start at most ${Math.abs(MIN_OFFSET_DAYS)} days before the due date.`;
  }
  if (offsetDays > MAX_OFFSET_DAYS) {
    return `Eva stops chasing ${MAX_OFFSET_DAYS} days after the due date.`;
  }
  return null;
}

/**
 * What each stage is FOR, in the customer's language.
 *
 * ⚠️ THIS IS PRODUCT COPY, NOT LABELS. `DATA-MODEL-REVIEW.md` §8 says the wedge
 * is what a reminder says; this screen is where a customer decides whether they
 * trust Eva to say it on their behalf, so the reasoning has to be visible.
 * `final_escalation` in particular must never read as "another reminder" — it
 * is the founder's "we are not debt collectors" boundary, and a customer who
 * mistakes it for a sixth email has misunderstood the product.
 */
const STEP_PURPOSE: Record<ReminderStepKey, string> = {
  pre_due_3:
    "A friendly nudge before the money is due. Most invoices are paid late because someone forgot, not because they won't pay.",
  due_date: "A short note on the day the money is due.",
  overdue_7: "The first chase, once the invoice is genuinely late.",
  overdue_14: "A firmer follow-up, still polite.",
  overdue_30: "The last email Eva sends on this invoice.",
  final_escalation:
    "Not an email. Eva stops here and hands the invoice back to you — she never threatens, and she never chases forever.",
};

export function stepPurpose(key: ReminderStepKey): string {
  return STEP_PURPOSE[key] ?? "A reminder.";
}

/**
 * True when the step is a handover to a human rather than an email to the
 * customer (`actionType === "internal_escalation"`). The screen has to say so:
 * switching it off is the difference between "Eva tells you to take over" and
 * "the invoice goes quiet and nobody is told".
 */
export function isHandover(actionType: string): boolean {
  return actionType !== "email";
}

/**
 * What turning a step off actually means, said before it is done.
 *
 * The handover case is the one worth spelling out — every other step going
 * quiet is one fewer email, but this one going quiet means nothing ever tells
 * the customer's own team that Eva has given up.
 */
export function describeDisabling(actionType: string): string {
  return isHandover(actionType)
    ? "Switch this off and Eva stops chasing without telling anyone. The invoice simply goes quiet."
    : "Switch this off and Eva skips this stage. The other reminders are unaffected.";
}
