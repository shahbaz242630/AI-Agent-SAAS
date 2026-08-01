import Link from "next/link";
import type { Metadata } from "next";

/**
 * Where a Microsoft 365 administrator lands after approving Eva for their
 * organisation.
 *
 * PUBLIC ON PURPOSE, and that is the whole reason this page exists. The
 * approver is usually the customer's IT contact following a forwarded link —
 * not an Eva user, and not signed in. Sending them to `/app/...` meant the
 * proxy bounced them to a sign-in page and threw the confirmation away, so the
 * one person we most need to reassure saw a login form and no evidence that
 * anything had worked. (Defect F2 was fixed for the raw-JSON error, but the
 * page it redirected to still required an account.)
 *
 * It shows no organisation name, no tenant id and no addresses — nothing that
 * would matter if the URL were shared, logged or left in browser history. The
 * approval itself is recorded server-side against the signed state; this page
 * is only the receipt.
 */

export const metadata: Metadata = {
  title: "Eva is approved",
  // A confirmation receipt has no business in search results.
  robots: { index: false, follow: false },
};

export default function MicrosoftApprovedPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <section className="flex w-full max-w-xl flex-col gap-4 text-center">
        <h1 className="text-2xl font-bold text-success">Eva is approved for your organisation</h1>
        <p className="text-muted-foreground">
          That&apos;s everything that was needed from you — thank you. Whoever asked you to approve
          this can now connect their mailbox.
        </p>
      </section>

      <section className="flex w-full max-w-xl flex-col gap-2 rounded-[var(--radius-card)] bg-muted px-6 py-5 text-sm">
        <h2 className="font-semibold">What you&apos;ve approved</h2>
        <p className="text-muted-foreground">
          Eva can read and send email from a mailbox{" "}
          <strong>only once its owner connects it</strong>, and only from that mailbox. Approving
          this doesn&apos;t give Eva access to anyone else&apos;s mail, and nothing is sent until
          they finish setting it up.
        </p>
        <p className="text-muted-foreground">
          You can withdraw this at any time from Microsoft Entra admin centre, under Enterprise
          applications.
        </p>
      </section>

      {/* For the case where the approver IS the customer — a sole trader or an
          owner who administers their own Microsoft 365. Anyone else can ignore
          it; it leads to a sign-in page, which is correct for them. */}
      <Link
        href="/app/settings/mailbox"
        className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Connect a mailbox
      </Link>
    </main>
  );
}
