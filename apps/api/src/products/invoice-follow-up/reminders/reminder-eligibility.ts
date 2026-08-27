import { isChasedInvoiceStatus } from "@eva/types";
import { resolveRecipient, type RecipientCandidates } from "./reminder-recipient.js";

/**
 * Slice 1.5 schedule-time eligibility (plan §3). Pure function — the caller
 * loads the invoice/contact/customer rows and evaluates the suppression check
 * (`isSuppressed`, which already normalises case); 1.7 re-checks inside the
 * send transaction per BRD 4.1.
 *
 * ⚠️ SUPPRESSION MUST BE CHECKED AGAINST THE ADDRESS `resolveRecipient` PICKS,
 * not against the contact's. Since 2026-08-27 those can differ — see
 * `reminder-recipient.ts`. Passing a verdict computed from the wrong address
 * would let Eva write to somebody who had asked her not to.
 */

export type IneligibilityReason =
  "not_active" | "no_contact" | "contact_deleted" | "no_email" | "suppressed";

/**
 * Eligible only when every BRD 4.1 / plan §3 exclusion is clear: the invoice is
 * Active (Paused/Disputed/Paid/Cancelled/Draft are never scheduled — the 1.2
 * display-status derivation already guarantees this for readers, this is the
 * schedule-side gate); SOMEBODY has an email address; and that address is not
 * suppressed (the suppression list is permanent and cross-channel, BRD 4.1).
 *
 * ⚠️ THE REASON VOCABULARY DID NOT CHANGE, AND THAT IS DELIBERATE. The web's
 * `BLOCKED_PHRASES` and four specs are keyed on these five strings. What
 * changed underneath is WHEN they are reached: a missing, deleted or
 * address-less contact is now only a blocker when the CLIENT has no address
 * either. The reason then still names the contact-side fact, because that is
 * the thing a person can act on from the row in front of them.
 */
export function checkReminderEligibility(
  input: {
    /** Stored invoice status. */
    invoiceStatus: string;
    suppressed: boolean;
  } & RecipientCandidates,
): { eligible: true } | { eligible: false; reason: IneligibilityReason } {
  /**
   * ⚠️ `partially_paid` IS CHASED (slice 1.6c). This read `!== "active"` until
   * payments landed, which would have made recording a part payment stop the
   * chase on the balance still owed — the exact defect migration 0019 exists to
   * fix. `CHASED_INVOICE_STATUSES` is the one list; do not spell it out here.
   */
  if (!isChasedInvoiceStatus(input.invoiceStatus)) {
    return { eligible: false, reason: "not_active" };
  }

  const recipient = resolveRecipient(input);
  if (recipient === null) {
    /**
     * Nobody at all has an address. The reason describes the CONTACT side even
     * though the client was checked too, because "add a contact" and "give this
     * person an email" are the two things a human can do about it — and the
     * order below is the same most-useful-first order this function has always
     * used.
     */
    if (input.contact === null) return { eligible: false, reason: "no_contact" };
    if (input.contact.deletedAt !== null) return { eligible: false, reason: "contact_deleted" };
    return { eligible: false, reason: "no_email" };
  }

  if (input.suppressed) return { eligible: false, reason: "suppressed" };
  return { eligible: true };
}
