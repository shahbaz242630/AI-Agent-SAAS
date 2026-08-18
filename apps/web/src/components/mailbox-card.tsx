/**
 * One connected mailbox, as both the settings page and the onboarding flow
 * show it.
 *
 * Takes a SINGLE mailbox and its callers render a list — which as of slice
 * 1.6a is a list of however many seats the organisation has bought, not the
 * list of one it was designed against in 1.6.
 *
 * Showing the address back is not decoration. It is the actual guarantee
 * behind defect F5: `login_hint` and `prompt=select_account` both merely ask
 * Microsoft to offer the right account, and `prompt` is known to be ignored
 * once a session context exists. A silently wrong mailbox is otherwise
 * invisible until a customer receives a chasing email from an address they do
 * not recognise.
 */

export interface MailboxSummary {
  id: string;
  emailAddress: string;
  displayName: string | null;
  healthStatus: "active" | "auth_expired" | "error" | null;
  isPrimary: boolean;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  /** Slice 1.6b. Optional so the onboarding flow, which renders this card from
   *  a freshly connected mailbox, need not care. */
  allocatedClientCount?: number;
}

export function MailboxCard({
  mailbox,
  /** Shown only when the organisation actually holds more than one — a badge on
   *  a list of one says nothing and invites "default compared to what?". */
  showPrimary = false,
  /** Slice 1.6b: link through to this mailbox's book. Off in onboarding, where
   *  no clients exist yet and the link would lead somewhere empty. */
  clientsHref,
  /**
   * Is there another HEALTHY mailbox that could stand in for this one
   * (ruling 6)? Decides whether an unhealthy mailbox means "chasing carries on
   * from elsewhere" or "chasing has stopped" — two completely different things
   * to tell a customer, and the second is the one that costs them money.
   *
   * Defaults false so a caller that has not thought about it gets the cautious
   * message rather than a reassuring one that might be untrue.
   */
  hasHealthyAlternative = false,
  actions,
}: {
  mailbox: MailboxSummary;
  showPrimary?: boolean;
  clientsHref?: string;
  hasHealthyAlternative?: boolean;
  actions?: React.ReactNode;
}) {
  const healthy = mailbox.healthStatus === "active";
  const count = mailbox.allocatedClientCount ?? 0;
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-background px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{mailbox.emailAddress}</span>
        {showPrimary && mailbox.isPrimary && (
          /**
           * "Sends from this one" was true when exactly one mailbox sent. Since
           * slice 1.6b EVERY seat sends, so the badge would now be a lie on a
           * list where all of them do. What is still true, and still needs
           * saying, is that this one picks up anybody nobody has filed
           * (ruling 1).
           */
          <span
            className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
            title="Clients you haven't filed under a mailbox are chased from this one"
          >
            Default for unfiled clients
          </span>
        )}
      </div>
      {mailbox.displayName && (
        <span className="text-sm text-muted-foreground">{mailbox.displayName}</span>
      )}
      <span className={`text-sm ${healthy ? "text-success" : "text-danger"}`}>
        {healthy ? "Connected" : (mailbox.lastError ?? "Connection problem — reconnect it.")}
      </span>

      {/*
        RULING 6, the loud half. A dead mailbox does not stop the chasing — the
        reminders go out from a healthy address belonging to the same business —
        so nothing else on this page would tell the customer anything is wrong.
        It has to be said here or it is never said at all.

        Worse for the default: ruling 1 sends every UNFILED client from it, so a
        dead default silently re-routes most of the book, not a handful.
      */}
      {!healthy && (
        <p className="rounded-[var(--radius-card)] bg-danger/10 px-3 py-2 text-sm text-danger">
          {/*
            ⚠️ The no-alternative branch is the one that matters, and the
            earlier version of this card got it exactly backwards.

            With a single mailbox — the common case, and the ONLY case during
            onboarding — `isPrimary` is true, so it announced that clients were
            "being chased from a different address" when there is no other
            address and `resolveSendingMailbox` returns null. It reported
            business as usual at the precise moment all chasing had stopped:
            the silent revenue stall the scope names as the catastrophic
            outcome, rendered as reassurance.
          */}
          {!hasHealthyAlternative
            ? "Reconnect this mailbox. Until you do, Eva has nowhere to send from and your clients are NOT being chased."
            : mailbox.isPrimary
              ? "Reconnect this mailbox. Until you do, every client you haven't filed elsewhere is being chased from a different address."
              : count > 0
                ? `Reconnect this mailbox. Until you do, its ${count === 1 ? "client is" : `${count} clients are`} being chased from a different address.`
                : "Reconnect this mailbox. Eva cannot send from it."}
        </p>
      )}

      {clientsHref && (
        <a href={clientsHref} className="text-sm font-medium text-link hover:underline">
          {count === 0
            ? "No clients filed here yet — file some"
            : `${count === 1 ? "1 client" : `${count} clients`} filed here`}
        </a>
      )}
      {actions}
    </div>
  );
}
