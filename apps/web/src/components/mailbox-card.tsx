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
}

export function MailboxCard({
  mailbox,
  /** Shown only when the organisation actually holds more than one — a
   *  "Primary" badge on a list of one says nothing and invites the question
   *  "primary compared to what?". */
  showPrimary = false,
  actions,
}: {
  mailbox: MailboxSummary;
  showPrimary?: boolean;
  actions?: React.ReactNode;
}) {
  const healthy = mailbox.healthStatus === "active";
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-background px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{mailbox.emailAddress}</span>
        {showPrimary && mailbox.isPrimary && (
          <span
            className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
            title="Eva sends reminders from this mailbox"
          >
            Sends from this one
          </span>
        )}
      </div>
      {mailbox.displayName && (
        <span className="text-sm text-muted-foreground">{mailbox.displayName}</span>
      )}
      <span className={`text-sm ${healthy ? "text-success" : "text-danger"}`}>
        {healthy ? "Connected" : (mailbox.lastError ?? "Connection problem — reconnect it.")}
      </span>
      {actions}
    </div>
  );
}
