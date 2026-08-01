/**
 * Callback outcomes from the API (apps/api modules/mailboxes), as a customer
 * reads them. Shared by the mailbox settings page and the setup flow so the two
 * cannot drift into telling the same person two different things.
 *
 * `consent_denied` carries the weight, and deliberately names BOTH causes.
 * Microsoft reports "your admin must approve this" and "you pressed cancel"
 * identically — proven on live staging 2026-07-30, defect F1 — so any message
 * that picks one is wrong half the time, and picking "you cancelled" strands
 * every customer who is not their own administrator.
 *
 * `admin_consent_required` is kept because the classifier is still correct if
 * Microsoft ever does send AADSTS90094, but it must never be relied on: that
 * code goes to Entra's sign-in log, not to the application.
 */
export const MAILBOX_ERROR_MESSAGES: Record<string, string> = {
  consent_denied:
    "We couldn't connect that mailbox. Either the connection was cancelled, or your Microsoft 365 administrator needs to approve Eva first.",
  admin_consent_required:
    "Your Microsoft 365 administrator needs to approve Eva before this mailbox can be connected. Ask them to authorise it, then try again.",
  mailbox_unavailable:
    "That Microsoft account doesn't have a mailbox — it may not have an Exchange Online licence. Connect the account you actually send email from.",
  // Almost always "you took too long at Microsoft", so say that rather than
  // leaving the customer wondering what they did wrong (observed 2026-07-31).
  invalid_state:
    "That took a bit too long, so the connection attempt expired. Nothing went wrong — just start again.",
  not_authorised:
    "Your access changed while you were connecting, so the mailbox wasn't linked. Ask an owner or administrator to connect it.",
  invalid_address: "That doesn't look like an email address — check it and try again.",
  missing_code: "Microsoft did not return an authorisation code — please try again.",
  exchange_failed: "We couldn't complete the Microsoft connection — please try again.",
  connect_failed: "We couldn't start the Microsoft connection — please try again.",
};

/**
 * The two codes that mean "Microsoft declined" and therefore deserve the whole
 * admin-approval section rather than a one-line flash: the customer may need to
 * involve their administrator, and that is the moment to hand them the link.
 */
export function needsConsentHelp(errorCode: string | null): boolean {
  return errorCode === "consent_denied" || errorCode === "admin_consent_required";
}

export function mailboxErrorMessage(errorCode: string): string {
  return MAILBOX_ERROR_MESSAGES[errorCode] ?? "Something went wrong — please try again.";
}
