import { MailboxScreen } from "@/capabilities/mailbox/mailbox-screen";

/**
 * Invoice Chasing's own mailbox (slice 3.1c-0).
 *
 * ⚠️ A DOOR, NOT A SCREEN. The whole page is `MailboxScreen`, shared with the
 * other product and parameterised by which product is asking — ruling 44's
 * "extract properly so the next area is an import rather than a paste". If
 * something here needs fixing, it needs fixing once, in the capability.
 *
 * ⚠️ AND IT IS A SEPARATE MAILBOX FROM THE OTHER PRODUCT'S, even when it is the
 * same address. Founder ruling 2026-09-01: two connections, two seats, two
 * grants, and switching either product off leaves the other sending.
 */
export default async function InvoiceChasingMailboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <MailboxScreen moduleKey="email_credit_controller" searchParams={searchParams} />;
}
