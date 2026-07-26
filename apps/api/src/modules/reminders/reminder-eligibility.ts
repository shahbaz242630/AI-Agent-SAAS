/**
 * Slice 1.5 schedule-time eligibility (plan §3). Pure function — the caller
 * loads the invoice/contact rows and evaluates the suppression check
 * (`isSuppressed`, which already normalises case); 1.7 re-checks inside the
 * send transaction per BRD 4.1.
 */

export type IneligibilityReason =
  "not_active" | "no_contact" | "contact_deleted" | "no_email" | "suppressed";

/**
 * Eligible only when every BRD 4.1 / plan §3 exclusion is clear: the invoice
 * is Active (Paused/Disputed/Paid/Cancelled/Draft are never scheduled — the
 * 1.2 display-status derivation already guarantees this for readers, this is
 * the schedule-side gate); a contact is linked; the contact is not
 * soft-deleted (the 1.4 observation — soft-deleted contacts stay linked on
 * invoices.contact_id, so this filter must be explicit); the contact has a
 * non-empty email; and the email is not suppressed (the suppression list is
 * permanent and cross-channel, BRD 4.1). Checks run in the order that gives
 * the most useful reason: status → presence → deletion → email → suppression.
 */
export function checkReminderEligibility(input: {
  /** Stored invoice status. */
  invoiceStatus: string;
  contact: { deletedAt: Date | null; email: string | null } | null;
  suppressed: boolean;
}): { eligible: true } | { eligible: false; reason: IneligibilityReason } {
  if (input.invoiceStatus !== "active") return { eligible: false, reason: "not_active" };
  if (input.contact === null) return { eligible: false, reason: "no_contact" };
  if (input.contact.deletedAt !== null) return { eligible: false, reason: "contact_deleted" };
  if (input.contact.email === null || input.contact.email.trim() === "") {
    return { eligible: false, reason: "no_email" };
  }
  if (input.suppressed) return { eligible: false, reason: "suppressed" };
  return { eligible: true };
}
