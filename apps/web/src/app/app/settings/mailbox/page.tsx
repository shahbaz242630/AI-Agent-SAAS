import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminConsentHelp } from "@/components/admin-consent-help";
import { MailboxCard, type MailboxSummary } from "@/components/mailbox-card";
import { ApiError, apiFetch } from "@/lib/api";
import { mailboxErrorMessage, needsConsentHelp } from "@/lib/mailbox-errors";
import { createClient } from "@/lib/supabase/server";
import { MailboxControls } from "./mailbox-controls";

// Response shapes mirror the API contracts (apps/api modules/mailboxes).
interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

interface AdminConsent {
  accountKind: "work" | "personal" | "unknown";
  url: string | null;
  organisationName: string | null;
}

export default async function MailboxSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  // Single-org app today — the /app list precedent; org switching is a later slice.
  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
  const organisation = organisations[0];

  let status: MailboxSummary | null = null;
  let forbidden = false;
  if (organisation) {
    try {
      status = (await (
        await apiFetch(`/organisations/${organisation.id}/mailbox`, accessToken)
      ).json()) as MailboxSummary;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      if (error instanceof ApiError && error.status === 403) forbidden = true;
      else throw error;
    }
  }

  const errorCode = typeof params.error === "string" ? params.error : null;
  const flashConnected = params.connected === "1";
  // Set only on a genuinely new connection — a reconnect sends nothing, so the
  // absence of this parameter is not a failure.
  const testEmailFailed = params.test_email === "failed";
  const flashAdminConsent = params.admin_consent === "granted";
  const attemptedAddress = typeof params.hint === "string" ? params.hint : null;

  // A declined consent is genuinely ambiguous (F1), so it gets a whole section
  // rather than a one-line flash: the customer may need to involve their
  // administrator, and that is the moment to hand them the link.
  const showConsentHelp = needsConsentHelp(errorCode);
  let adminConsent: AdminConsent | null = null;
  if (showConsentHelp && organisation && !forbidden) {
    try {
      const query = attemptedAddress ? `?email=${encodeURIComponent(attemptedAddress)}` : "";
      adminConsent = (await (
        await apiFetch(
          `/organisations/${organisation.id}/mailbox/admin-consent${query}`,
          accessToken,
        )
      ).json()) as AdminConsent;
    } catch (error) {
      // The help is an enhancement; the message below still explains the
      // situation without it. Never turn a failed connection into a crash.
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      adminConsent = null;
    }
  }

  const flashError = errorCode && !showConsentHelp ? mailboxErrorMessage(errorCode) : null;

  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">Mailbox settings</h1>
        <p className="text-sm text-muted-foreground">
          Connect the Microsoft 365 mailbox Eva sends reminders from.
        </p>
      </section>

      {flashConnected && (
        <p
          role="status"
          className="w-full max-w-2xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-success"
        >
          {params.test_email === "sent"
            ? "Mailbox connected. We've sent a test email to it — check the inbox."
            : "Mailbox connected successfully."}
        </p>
      )}
      {/* The connection itself succeeded, so this is a caveat rather than an
          error: reading mail was already proven, only the send failed. */}
      {testEmailFailed && (
        <p
          role="status"
          className="w-full max-w-2xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-muted-foreground"
        >
          The mailbox is connected, but we couldn&apos;t send its test email. Try{" "}
          <span className="font-medium">Send test email</span> below.
        </p>
      )}
      {/* The approver is usually the customer's IT contact and not an Eva user
          at all, so this must never claim a mailbox is now connected —
          somebody else still has to do that. */}
      {flashAdminConsent && (
        <p
          role="status"
          className="w-full max-w-2xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-success"
        >
          Eva is approved for your organisation. Whoever asked for this approval can now connect
          their mailbox.
        </p>
      )}
      {flashError && (
        <p
          role="alert"
          className="w-full max-w-2xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-danger"
        >
          {flashError}
        </p>
      )}
      {showConsentHelp && (
        <AdminConsentHelp
          accountKind={adminConsent?.accountKind ?? "unknown"}
          url={adminConsent?.url ?? null}
          organisationName={adminConsent?.organisationName ?? null}
          attemptedAddress={attemptedAddress}
        />
      )}

      {!organisation ? (
        <p className="w-full max-w-2xl text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-primary hover:underline">
            New organisation
          </Link>
        </p>
      ) : forbidden ? (
        <p className="w-full max-w-2xl text-sm text-muted-foreground">
          Your role doesn&apos;t have access to mailbox settings for {organisation.name}. Ask an
          owner or administrator.
        </p>
      ) : status ? (
        <section className="flex w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          {/* A list of one today; 1.6a's seats turn it into a list of several. */}
          {status.connected ? (
            [status].map((mailbox) => <MailboxCard key={mailbox.emailAddress} mailbox={mailbox} />)
          ) : (
            <p className="text-sm text-muted-foreground">No mailbox connected yet.</p>
          )}
          <MailboxControls
            organisationId={organisation.id}
            connected={status.connected}
            reconnectNeeded={status.healthStatus === "auth_expired"}
            defaultAddress={attemptedAddress}
          />
        </section>
      ) : null}

      <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
        Back to your organisations
      </Link>
    </main>
  );
}
