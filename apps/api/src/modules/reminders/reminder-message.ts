import { formatMinorUnits, outstandingBalance, type ReminderStepKey } from "@eva/types";

/**
 * The words Eva actually sends (Slice 1.7).
 *
 * This file is the product. Everything before it — the scheduler, the spacing
 * rules, the eligibility gate — is plumbing that Zoho also has. The founder's
 * ruling (2026-08-07, and `DATA-MODEL-REVIEW.md` §8) is that the competitor's
 * reminder is *"a random message saying your 1000 aed invoice is overdue pay on
 * below link"*, and that what a reminder SAYS is the wedge.
 *
 * So there are deliberately **no `{{Balance}}` / `{{OverdueDays}}` template
 * slots**. Each stage is written as prose, in its own register, because a
 * template engine cannot change its mind about tone — and a tone ladder is
 * exactly what was bought. Shipping placeholder slots here would rebuild the
 * thing the founder switched off.
 *
 * ⚠️ Pure functions only. No database, no clock, no I/O — every date and figure
 * arrives as an argument, so the whole ladder is testable without a fixture and
 * the caller (which knows the ORG timezone) stays the only thing that resolves
 * "today". Deriving a day count in here would recreate the browser-timezone
 * defect the invoice screens were bitten by.
 */

/**
 * The five stages that produce a customer-facing email.
 *
 * ⚠️ `final_escalation` is EXCLUDED AT THE TYPE LEVEL, not by a runtime guard.
 * It is the internal handover to a human — it must never reach a customer's
 * inbox, and the founder's whole "we are not debt collectors" rule depends on
 * that. A guard can be forgotten by the next caller; a type cannot compile.
 */
export type EmailReminderStepKey = Exclude<ReminderStepKey, "final_escalation">;

export interface ReminderMessageInput {
  stepKey: EmailReminderStepKey;
  /** The invoice's own reference as the customer knows it, e.g. INV-1001. */
  invoiceReference: string;
  /** UTC-midnight Date standing for the org-local due day (scheduler convention). */
  dueDate: Date;
  /** ISO-4217, per INVOICE — never the organisation default (§0d). */
  currency: string;
  amountMinorUnits: bigint;
  amountPaidMinorUnits: bigint;
  /**
   * Days past the due date on the day this sends, computed by the caller from
   * the ORG timezone. Negative means it is not due yet. Passed rather than
   * derived from `stepKey` because offsets are configurable per organisation —
   * an org may move `overdue_30` to +45, and the email must not then claim 30.
   */
  daysOverdue: number;
  /** The person being written to. Null/blank falls back to a neutral opener. */
  contactName: string | null;
  /** Signed off as the ORGANISATION — Eva never signs its own name. */
  organisationName: string;
}

export interface ReminderMessage {
  subject: string;
  bodyText: string;
}

/**
 * en-GB long date, formatted in UTC on purpose: `dueDate` is a UTC-midnight
 * stand-in for an org-local calendar day, so formatting it in any other zone
 * would slide it a day and tell a customer the wrong date.
 */
function formatDueDate(dueDate: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(dueDate);
}

/**
 * "GBP 1250.00" — the ISO code, always, never a bare symbol.
 *
 * ⚠️ The extractor once turned every Dubai invoice into a sterling one by
 * assuming an unlabelled total was GBP. A reminder that names a figure without
 * naming its currency invites the customer to make the same mistake, and "pay
 * 50,000" reads very differently in AED and KWD.
 */
function money(minorUnits: bigint, currency: string): string {
  return `${currency} ${formatMinorUnits(minorUnits, currency)}`;
}

/** "Hi Sarah," — or a neutral opener when we have no name to use. */
function greeting(contactName: string | null): string {
  const name = contactName?.trim();
  return name ? `Hi ${name},` : "Hello,";
}

/**
 * The one thing a template engine structurally cannot say.
 *
 * A part-paid invoice is chased for the BALANCE, and the payment that was made
 * is thanked for by name. Chasing the full amount after someone has paid most
 * of it is the single fastest way to damage the relationship the founder's
 * escalation rule exists to protect — and it is precisely what a `{{Balance}}`
 * slot gets right arithmetically and wrong socially.
 */
function paymentAcknowledgement(
  amountMinorUnits: bigint,
  amountPaidMinorUnits: bigint,
  currency: string,
): string | null {
  if (amountPaidMinorUnits <= 0n) return null;
  const balance = outstandingBalance(amountMinorUnits, amountPaidMinorUnits);
  if (balance <= 0n) return null;
  // The outstanding figure is NOT repeated here: every stage already opens with
  // the balance, and quoting the same sum twice in three lines reads like a
  // machine arguing with itself.
  return (
    `Thank you for the ${money(amountPaidMinorUnits, currency)} already paid ` +
    `against this invoice — the amount above is what remains outstanding.`
  );
}

/** Joins the paragraphs of a body, dropping the ones that did not apply. */
function body(...paragraphs: Array<string | null>): string {
  return paragraphs.filter((p): p is string => p !== null).join("\n\n");
}

/**
 * Builds the subject and body for one reminder.
 *
 * The ladder is the founder's ruling of 2026-08-07: warm heads-up → friendly →
 * polite nudge → firmer → serious final notice, and then Eva stops and hands
 * over to a human. It hardens, but it never threatens: there is no legal
 * language, no late-fee warning and no deadline Eva has no authority to set.
 *
 * ⚠️ The last email SAYS it is the last one, and that has to stay true. It is
 * only honest because `final_escalation` follows it — if a future change lets
 * the sequence keep emailing past `overdue_30`, this copy becomes a lie.
 */
export function buildReminderMessage(input: ReminderMessageInput): ReminderMessage {
  const {
    stepKey,
    invoiceReference,
    currency,
    amountMinorUnits,
    amountPaidMinorUnits,
    daysOverdue,
    contactName,
    organisationName,
  } = input;

  // Every figure quoted to the customer is what they still OWE, never the
  // invoice's face value (§0d: overpayment is allowed, so this clamps at zero).
  const balance = outstandingBalance(amountMinorUnits, amountPaidMinorUnits);
  const amount = money(balance, currency);
  const due = formatDueDate(input.dueDate);
  const hello = greeting(contactName);
  const paid = paymentAcknowledgement(amountMinorUnits, amountPaidMinorUnits, currency);
  const signOff = `Many thanks,\n${organisationName}`;
  const days = Math.max(daysOverdue, 0);
  // "1 days overdue" is the kind of detail that tells a reader a machine wrote
  // this and nobody checked. Rare before slice 1.8b; common after it, because
  // the guard below routes freshly-overdue invoices through the chase stages.
  const dayCount = `${days} ${days === 1 ? "day" : "days"}`;

  /**
   * ⚠️ THE STEP SAYS WHEN THE EMAIL WAS MEANT TO GO; `daysOverdue` SAYS WHERE
   * THE INVOICE ACTUALLY IS. WHEN THEY DISAGREE, REALITY WINS.
   *
   * `pre_due_3` and `due_date` are the only two stages whose wording makes a
   * claim about the future — "is due on the 26th", "is due today". Every
   * overdue stage already counts from the real date and is correct whenever it
   * fires. So those two, and only those two, can be sent on a day that makes
   * them false, and `due_date` is the worse of the pair: it tells a customer's
   * client an invoice is due today when it went past due a week ago.
   *
   * Three ways a row reaches that state, which is why this is a SEND-TIME guard
   * and not a scheduling fix — scheduling can only prevent the paths we thought
   * of, and this is the last point at which the truth is known:
   *   1. the catch-up collapse moves a missed step to today (1.5, §7.5);
   *   2. the 3-day spacing pass defers a collapsed step FORWARD, which is how a
   *      pre-due note ended up 3 days PAST the due date in the 2026-08-08 send;
   *   3. a due date edited after the row was scheduled, or a sweep that runs
   *      late because sending was held.
   *
   * Routed to `overdue_7` rather than given new prose: it is the gentlest chase
   * we have, it assumes good faith out loud, and the founder's ruling was
   * "rest of reminders as you already designed" — inventing a seventh register
   * here would be answering a question nobody asked.
   */
  const arrivesLate = daysOverdue > 0 && (stepKey === "pre_due_3" || stepKey === "due_date");
  const effectiveStepKey: EmailReminderStepKey = arrivesLate ? "overdue_7" : stepKey;

  switch (effectiveStepKey) {
    // Before the due date. This one exists to prevent a late payment rather
    // than chase one, so it must not read as a chase at all — most invoices
    // are paid late because someone forgot, not because they are avoiding it.
    case "pre_due_3":
      return {
        subject: `Invoice ${invoiceReference} is due on ${due}`,
        bodyText: body(
          hello,
          `Just a quick note that invoice ${invoiceReference} for ${amount} is due on ${due}.`,
          paid,
          `If it is already scheduled for payment, please ignore this — there is nothing to do.`,
          signOff,
        ),
      };

    case "due_date":
      return {
        subject: `Invoice ${invoiceReference} is due today`,
        bodyText: body(
          hello,
          `Invoice ${invoiceReference} for ${amount} is due today.`,
          paid,
          `If payment is already on its way, thank you — please ignore this note.`,
          signOff,
        ),
      };

    // First chase after the due date. Assumes good faith out loud, and opens
    // the door to a reply: a disputed invoice that nobody mentioned is the
    // most common reason a chase sequence runs to the end achieving nothing.
    case "overdue_7":
      return {
        subject: `Invoice ${invoiceReference} — ${dayCount} overdue`,
        bodyText: body(
          hello,
          `Invoice ${invoiceReference} for ${amount} was due on ${due}, so it is now ${dayCount} overdue.`,
          paid,
          `I know how easily these slip through — could you let me know when we can expect payment? ` +
            `If there is a problem with the invoice, just reply and we will sort it out.`,
          signOff,
        ),
      };

    // Firmer. Asks for a specific commitment (a date) rather than repeating
    // the request, because a second identical nudge teaches the reader that
    // the reminders can safely be ignored.
    case "overdue_14":
      return {
        subject: `Invoice ${invoiceReference} is now ${dayCount} overdue`,
        bodyText: body(
          hello,
          `Invoice ${invoiceReference} for ${amount} was due on ${due} and is still unpaid, ` +
            `now ${dayCount} past the due date.`,
          paid,
          `Could you arrange payment, or reply with a date we can expect it? ` +
            `If something is holding it up, I would rather know than keep chasing.`,
          signOff,
        ),
      };

    // The last automatic email. Serious, but still no threat — the honest
    // escalation here is that a person takes over, which is exactly what
    // happens next, and saying so is more credible than inventing a penalty.
    case "overdue_30":
      return {
        subject: `Invoice ${invoiceReference} — ${dayCount} overdue, final reminder`,
        bodyText: body(
          hello,
          `Invoice ${invoiceReference} for ${amount} was due on ${due} and is now ${dayCount} overdue.`,
          paid,
          `This is the last automatic reminder I will send. Please arrange payment, or reply with a ` +
            `date, so we can settle this between us.`,
          `If you believe this invoice has already been paid, send me the payment details and I will check.`,
          signOff,
        ),
      };
  }
}
