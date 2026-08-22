/**
 * Callback outcomes from the API (apps/api capabilities/mailbox), as a customer
 * reads them. Shared by the mailbox settings page and the setup flow so the two
 * cannot drift into telling the same person two different things.
 *
 * ⚠️ SPLIT BY PROVIDER ON 2026-08-22, BY FOUNDER RULING: "they should be
 * separate, no crossing paths."
 *
 * Until then every message lived in one map, and `handleCallback` is shared by
 * both providers — so a Gmail customer who pressed Cancel at Google was told
 * their "Microsoft 365 administrator needs to approve Eva" and shown an Entra
 * approval panel. They have no administrator and never touched Microsoft. The
 * structure now makes that unsayable rather than merely fixed: a message that
 * names one provider has to sit in that provider's map, and getting there
 * requires a provider to have been passed in.
 *
 * Three groups, and which one a message belongs in is a real decision:
 *   SHARED     — the outcome and the wording are true for both. Naming a
 *                provider here is the bug this split exists to prevent.
 *   MICROSOFT  — only a Microsoft connection can produce it (admin consent,
 *                Exchange licences), and the wording is about their world.
 *   GOOGLE     — only a Google connection can produce it (the granular-consent
 *                checkbox), likewise.
 */

/** The providers a mailbox can be connected through. Mirrors the API's
 *  `MAIL_PROVIDER_KEYS`; the two are kept in step by the callback's redirect. */
export type MailboxProviderKey = "microsoft" | "google";

/**
 * The provider named on the callback's redirect, or Microsoft.
 *
 * ⚠️ THE FALLBACK IS DELIBERATE AND MATCHES `settings/actions.ts`: Microsoft is
 * the provider that has always worked, and every link written before this slice
 * has no `provider` parameter at all. Falling back to Google would silently
 * rewrite the past — somebody following an old bookmark after a Microsoft
 * failure would be handed Google's advice.
 */
export function mailboxProviderFrom(value: unknown): MailboxProviderKey {
  return value === "google" ? "google" : "microsoft";
}

/**
 * Outcomes that mean the same thing whichever provider the customer chose.
 *
 * ⚠️ NOTHING IN HERE MAY NAME A PROVIDER, AND A TEST ENFORCES IT.
 * `handleCallback` takes the provider as an argument, so every one of these is
 * reachable from either side. Three of them named Microsoft until 3.1b and a
 * Gmail customer could read all three; the previous session judged this file
 * Microsoft-only and correct, which is true per-ENTRY and not as a whole.
 */
export const MAILBOX_ERROR_MESSAGES: Record<string, string> = {
  // Almost always "you took too long at the provider", so say that rather than
  // leaving the customer wondering what they did wrong (observed 2026-07-31).
  invalid_state:
    "That took a bit too long, so the connection attempt expired. Nothing went wrong — just start again.",
  // "Owner" means an Eva role, not a provider one. Said explicitly: this slice
  // exists because people cannot tell our permissions from their provider's.
  not_authorised:
    "Your permissions changed while you were connecting, so the mailbox wasn't linked. Ask an owner of this Eva organisation to connect it.",
  // The @Public() callback inherits requirePermission's 402. Reachable when a
  // product is switched off while someone is away at the provider — rare, but
  // "try again" would be advice that can never work.
  module_not_entitled:
    "Your organisation doesn't have Invoice Chasing, so the mailbox wasn't connected. Turn it on under Your products, then try again.",
  // Slice 1.6a. Reachable despite the pre-check on connect, because the
  // authoritative check runs after the round trip — two people connecting at
  // once, or a seat taken while this one was away.
  seat_limit_reached:
    "Every mailbox seat is already in use, so that mailbox wasn't connected. Disconnect one, or add a seat, then try again.",
  invalid_address: "That doesn't look like an email address — check it and try again.",
  // Was "did not return an authorisation code", which is our plumbing, not
  // anything the reader can act on.
  missing_code: "Signing you in didn't finish — please try again.",
  exchange_failed: "We couldn't complete the connection — please try again.",
  connect_failed: "We couldn't start the connection — please try again.",
};

/**
 * Outcomes only one provider can produce, in that provider's own terms.
 *
 * A code here shadows the shared map for that provider and is invisible to the
 * other, which is the whole point: neither customer is ever shown the other's
 * world.
 */
export const PROVIDER_ERROR_MESSAGES: Record<MailboxProviderKey, Record<string, string>> = {
  microsoft: {
    /**
     * Names BOTH causes, and must keep doing so. Microsoft reports "your admin
     * must approve this" and "you pressed cancel" identically — proven on live
     * staging 2026-07-30, defect F1 — so any message that picks one is wrong
     * half the time, and picking "you cancelled" strands every customer who is
     * not their own administrator.
     *
     * A FALLBACK in practice: both callers route this code to
     * `AdminConsentHelp`, because a one-line flash cannot carry an approval
     * link and a forwardable email.
     */
    consent_denied:
      "We couldn't connect that mailbox. Either the connection was cancelled, or your Microsoft 365 administrator needs to approve Eva first.",
    /**
     * Kept because the classifier is still correct if Microsoft ever does send
     * AADSTS90094, but never relied on: that code goes to Entra's sign-in log,
     * not to the application.
     */
    admin_consent_required:
      "Your Microsoft 365 administrator needs to approve Eva before this mailbox can be connected. Ask them to authorise it, then try again.",
    /**
     * Microsoft-only because only `GraphMailProvider.probeMailbox` raises it —
     * Gmail's probe is a documented no-op, since asking Google the same
     * question needs a restricted scope (ruling 25).
     *
     * Names BOTH causes for F1's reason: the SAME licence-less account answered
     * a bare 401 on 2026-07-31 and an HTTP 500 on 2026-08-01, so "this account
     * has no licence" is an assertion we cannot make.
     */
    mailbox_unavailable:
      "We couldn't open that mailbox. It may not include email (no Exchange Online licence), or Microsoft may be having a moment. Try again — and if it keeps failing, sign in with the account you actually send email from.",
  },
  google: {
    /**
     * ⚠️ NOT MICROSOFT'S SENTENCE, AND NOT AMBIGUOUS EITHER. Google has no
     * admin-consent concept to describe here, so unlike F1 there is no second
     * cause to hedge against: the customer stopped. Saying so plainly, and
     * saying that nothing has changed, is the whole message.
     */
    consent_denied:
      "The connection was cancelled at Google, so no mailbox was connected. Nothing has changed — start again whenever you're ready.",
    /**
     * The defect found by walking production on 2026-08-22. Google's consent
     * screen lists the send permission as its own checkbox, unticked by
     * default, so the customer completes the whole sign-in and grants
     * everything except the one thing Eva needs.
     *
     * ⚠️ IT SAYS WHAT TO DO, NOT WHAT WENT WRONG, and it quotes Google's own
     * words back. The customer did not fail at anything; they clicked through a
     * screen designed to be clicked through. "We couldn't connect that mailbox"
     * would leave them repeating the same steps for the same result, which is
     * defect F3 all over again.
     */
    send_permission_denied:
      "Nearly there — Eva wasn't given permission to send email, so the mailbox wasn't connected. Try again, and on the Google screen tick \"Send email on your behalf\" before continuing.",
  },
};

/**
 * Whether this outcome deserves the whole admin-approval section rather than a
 * one-line flash.
 *
 * ⚠️ MICROSOFT ONLY, BY RULING. `AdminConsentHelp` is a panel about Entra
 * approval, an approval link, and an email to forward to an IT contact. Shown
 * to somebody who cancelled at Google it is not merely irrelevant — it invents
 * an administrator they do not have and a step they cannot take.
 */
export function needsConsentHelp(
  errorCode: string | null,
  provider: MailboxProviderKey = "microsoft",
): boolean {
  if (provider !== "microsoft") return false;
  return errorCode === "consent_denied" || errorCode === "admin_consent_required";
}

/**
 * The sentence for one outcome. The provider's own map wins where it has an
 * entry, so a shared fallback can never overwrite a provider-specific truth.
 */
export function mailboxErrorMessage(
  errorCode: string,
  provider: MailboxProviderKey = "microsoft",
): string {
  return (
    PROVIDER_ERROR_MESSAGES[provider][errorCode] ??
    MAILBOX_ERROR_MESSAGES[errorCode] ??
    "Something went wrong — please try again."
  );
}
