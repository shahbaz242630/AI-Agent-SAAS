import { MailboxScreen } from "@/capabilities/mailbox/mailbox-screen";
import type { MailboxProviderKey } from "@/capabilities/mailbox/mailbox-errors";
import { EnquiryIntake } from "./enquiry-intake";

/**
 * Lead Follow-up's email set-up, in one place (slice 3.1c-0; two halves since
 * 2026-09-05).
 *
 * ⚠️ THE TOP HALF IS A DOOR, NOT A SCREEN. It is `MailboxScreen`, shared with
 * the other product and parameterised by which product is asking — ruling
 * 44's "extract properly so the next area is an import rather than a paste".
 * If something there needs fixing, it needs fixing once, in the capability.
 *
 * ⚠️ THE BOTTOM HALF IS THIS PRODUCT'S OWN. Where enquiries come in — the
 * address and the forwarding steps — exists for no other product, so it is
 * handed to the capability's `after` slot from here rather than built into a
 * screen Invoice Chasing also draws (founder, 2026-09-05: *"it should be on
 * mailbox tab.. with a short step by step guide"*).
 *
 * ⚠️ AND IT IS A SEPARATE MAILBOX FROM THE OTHER PRODUCT'S, even when it is the
 * same address. Founder ruling 2026-09-01: two connections, two seats, two
 * grants, and switching either product off leaves the other sending.
 */
export default async function LeadFollowUpEmailMailboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <MailboxScreen
      moduleKey="lead_follow_up"
      searchParams={searchParams}
      subtitle="Where enquiries come in, and the mailbox Lead Follow-up replies from — Outlook, Microsoft 365 or Gmail."
      heading="Where Eva replies from"
      after={({ organisation, accessToken, mailboxes }) => (
        <EnquiryIntake
          organisationId={organisation.id}
          accessToken={accessToken}
          canSetUp={organisation.permissions.includes("leads:write")}
          timezone={organisation.timezone ?? "Europe/London"}
          // The guide follows the connected mailbox's provider. A row from an
          // api that does not say (there were none after 2026-09-05) is
          // skipped rather than guessed — guessing Outlook for a Gmail
          // customer is exactly the crossing ruling 35 forbids.
          providers={mailboxes.flatMap((mailbox): MailboxProviderKey[] =>
            mailbox.provider === "google" || mailbox.provider === "microsoft"
              ? [mailbox.provider]
              : [],
          )}
        />
      )}
    />
  );
}
