/**
 * One connected mailbox, as both the settings page and the onboarding flow
 * show it.
 *
 * Deliberately takes a SINGLE mailbox rather than the whole status payload, and
 * its callers render it from a list of one. Slice 1.6a turns this endpoint into
 * a list — seats, `is_primary`, a mailbox id in the routes — because today's
 * "one live mailbox per organisation" is only a database index, and connecting
 * a second one silently overwrites the first. Shaping the component that way
 * now costs a few lines and saves rebuilding the screen a fortnight later.
 *
 * Showing the address back is not decoration. It is the actual guarantee behind
 * defect F5: `login_hint` and `prompt=select_account` both merely ask Microsoft
 * to offer the right account, and `prompt` is known to be ignored once a
 * session context exists. A silently wrong mailbox is otherwise invisible until
 * a customer receives a chasing email from an address they do not recognise.
 */

export interface MailboxSummary {
  connected: boolean;
  emailAddress: string | null;
  displayName: string | null;
  healthStatus: "active" | "auth_expired" | "error" | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
}

export function MailboxCard({ mailbox }: { mailbox: MailboxSummary }) {
  const healthy = mailbox.healthStatus === "active";
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{mailbox.emailAddress}</span>
      {mailbox.displayName && <span className="text-muted-foreground">{mailbox.displayName}</span>}
      <span className={healthy ? "text-success" : "text-danger"}>
        {healthy
          ? "Connected"
          : (mailbox.lastError ?? "Connection problem — reconnect the mailbox.")}
      </span>
    </div>
  );
}
