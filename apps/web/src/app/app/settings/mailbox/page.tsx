import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";
import { AdminConsentHelp } from "./admin-consent-help";
import { MailboxControls } from "./mailbox-controls";

// Response shapes mirror the API contracts (apps/api modules/mailboxes).
interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

interface MailboxStatus {
  connected: boolean;
  emailAddress: string | null;
  displayName: string | null;
  healthStatus: "active" | "auth_expired" | "error" | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
}

interface AdminConsent {
  accountKind: "work" | "personal" | "unknown";
  url: string | null;
  organisationName: string | null;
}

/**
 * Callback error codes from the API (mailboxes service).
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
const ERROR_MESSAGES: Record<string, string> = {
  consent_denied:
    "We couldn't connect that mailbox. Either the connection was cancelled, or your Microsoft 365 administrator needs to approve Eva first.",
  admin_consent_required:
    "Your Microsoft 365 administrator needs to approve Eva before this mailbox can be connected. Ask them to authorise it, then try again.",
  mailbox_unavailable:
    "That Microsoft account doesn't have a mailbox — it may not have an Exchange Online licence. Connect the account you actually send email from.",
  invalid_state: "The connection attempt expired or was invalid — please try again.",
  not_authorised:
    "Your access changed while you were connecting, so the mailbox wasn't linked. Ask an owner or administrator to connect it.",
  missing_code: "Microsoft did not return an authorisation code — please try again.",
  exchange_failed: "We couldn't complete the Microsoft connection — please try again.",
  connect_failed: "We couldn't start the Microsoft connection — please try again.",
};

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

  let status: MailboxStatus | null = null;
  let forbidden = false;
  if (organisation) {
    try {
      status = (await (
        await apiFetch(`/organisations/${organisation.id}/mailbox`, accessToken)
      ).json()) as MailboxStatus;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      if (error instanceof ApiError && error.status === 403) forbidden = true;
      else throw error;
    }
  }

  const errorCode = typeof params.error === "string" ? params.error : null;
  const flashConnected = params.connected === "1";
  const flashAdminConsent = params.admin_consent === "granted";
  const attemptedAddress = typeof params.hint === "string" ? params.hint : null;

  // A declined consent is genuinely ambiguous (F1), so it gets a whole section
  // rather than a one-line flash: the customer may need to involve their
  // administrator, and that is the moment to hand them the link.
  const showConsentHelp = errorCode === "consent_denied" || errorCode === "admin_consent_required";
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

  const flashError =
    errorCode && !showConsentHelp
      ? (ERROR_MESSAGES[errorCode] ?? "Something went wrong — please try again.")
      : null;

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
          Mailbox connected successfully.
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
          {status.connected ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{status.emailAddress}</span>
              {status.displayName && (
                <span className="text-muted-foreground">{status.displayName}</span>
              )}
              <span className={status.healthStatus === "active" ? "text-success" : "text-danger"}>
                {status.healthStatus === "active"
                  ? "Connected"
                  : (status.lastError ?? "Connection problem — reconnect the mailbox.")}
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No mailbox connected yet.</p>
          )}
          <MailboxControls
            organisationId={organisation.id}
            connected={status.connected}
            reconnectNeeded={status.healthStatus === "auth_expired"}
          />
        </section>
      ) : null}

      <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
        Back to your organisations
      </Link>
    </main>
  );
}
