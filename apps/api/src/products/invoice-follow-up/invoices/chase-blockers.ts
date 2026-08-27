import {
  checkReminderEligibility,
  type IneligibilityReason,
} from "../reminders/reminder-eligibility.js";

/**
 * Why Eva would not email a reminder for this invoice (slice 1.6c).
 *
 * ⚠️ WHY THIS EXISTS. Until now the screens could see exactly one of the ways a
 * chase silently does not happen — a missing recipient — and confidently said
 * "Eva will chase it" in all the others. An invoice whose contact has no email
 * address, or who asked not to be emailed, or whose organisation has no working
 * mailbox, is scheduled nothing and reports success. The product was telling
 * customers their debtors were being chased when nobody was.
 *
 * ⚠️ IT DELEGATES TO `checkReminderEligibility` ON PURPOSE, and must keep doing
 * so. That function is the SCHEDULER's gate — the thing that actually decides
 * whether rows are written. A second, parallel list of reasons here would drift
 * from it, and the failure mode of that drift is precisely the defect this file
 * exists to remove: a screen that promises a chase the scheduler refuses.
 */
export type ChaseBlockedReason =
  | Exclude<IneligibilityReason, "not_active">
  /** The organisation has no live, healthy mailbox — nothing can send at all. */
  | "no_mailbox";

/**
 * ⚠️ IT TAKES THE CLIENT NOW, AND A CALLER THAT PASSES `customer: null` IS
 * ASKING A DIFFERENT QUESTION THAN IT THINKS. Since 2026-08-27 Eva falls back
 * to the client's own address when there is no usable contact
 * (`reminder-recipient.ts`), so a screen that omits the client would print
 * "nobody is set to receive reminders" beside invoices the scheduler is
 * perfectly happy to chase — the screen contradicting the sender, which is the
 * exact defect this file was created to remove.
 */
export function resolveChaseBlockedReason(input: {
  contact: { id: string; name: string; deletedAt: Date | null; email: string | null } | null;
  customer: { id: string; email: string | null } | null;
  suppressed: boolean;
  organisationHasHealthyMailbox: boolean;
}): ChaseBlockedReason | null {
  /**
   * ⚠️ THE STATUS IS DELIBERATELY FIXED TO "active", AND THAT IS NOT A BUG.
   *
   * This answers "what ELSE would stop Eva", with the invoice's own status set
   * aside, and it has two readers that both need it that way:
   *
   *   - the list, where the status is already on the badge beside it — repeating
   *     "not active" next to a badge reading Cancelled is noise;
   *   - the Start chasing button, which must say what will happen AFTER the
   *     status changes. Asked about a draft, a status-first check answers "it's
   *     a draft", which is useless for predicting whether activating it will
   *     actually email anybody.
   *
   * Callers combine it with the status themselves: an invoice is being chased
   * when it is Active AND this is null.
   */
  const eligibility = checkReminderEligibility({
    invoiceStatus: "active",
    contact: input.contact,
    customer: input.customer,
    suppressed: input.suppressed,
  });
  if (!eligibility.eligible) {
    // `not_active` is unreachable — we just passed "active" — but narrowing it
    // away by construction is worth more than a cast: if the scheduler ever
    // reorders its checks, this stops compiling rather than lying.
    return eligibility.reason === "not_active" ? null : eligibility.reason;
  }
  // Last, because it is an ORGANISATION-level fault and every row would report
  // it. The per-invoice reasons are the ones a person fixes row by row.
  if (!input.organisationHasHealthyMailbox) return "no_mailbox";
  return null;
}
