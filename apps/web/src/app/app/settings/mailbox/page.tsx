import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminConsentHelp } from "@/components/admin-consent-help";
import { MailboxCard, type MailboxSummary } from "@/components/mailbox-card";
import { ApiError, apiFetch } from "@/lib/api";
import { mailboxErrorMessage, needsConsentHelp } from "@/lib/mailbox-errors";
import { createClient } from "@/lib/supabase/server";
import { ConnectMailboxForm, MailboxActions } from "./mailbox-controls";

// Response shapes mirror the API contracts (apps/api modules/mailboxes).
interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

interface MailboxList {
  mailboxes: MailboxSummary[];
  seats: number;
  seatLimitReached: boolean;
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

  let status: MailboxList | null = null;
  let forbidden = false;
  let notEntitled = false;
  if (organisation) {
    try {
      status = (await (
        await apiFetch(`/organisations/${organisation.id}/mailboxes`, accessToken)
      ).json()) as MailboxList;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      if (error instanceof ApiError && error.status === 403) forbidden = true;
      // 402 is not 403: "your organisation hasn't got this product" needs an
      // upgrade prompt, not "ask your owner for permission" (slice 1.6a).
      else if (error instanceof ApiError && error.status === 402) notEntitled = true;
      else throw error;
    }
  }

  const errorCode = typeof params.error === "string" ? params.error : null;
  const flashConnected = params.connected === "1";
  // Set only on a genuinely new connection — a reconnect sends nothing, so the
  // absence of this parameter is not a failure.
  const testEmailFailed = params.test_email === "failed";
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
          `/organisations/${organisation.id}/mailboxes/admin-consent${query}`,
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

      {/* ONE message, three endings. `test_email` only ever arrives alongside
          `connected=1`, so a separate box for the failure printed "Mailbox
          connected successfully" directly above "we couldn't send its test
          email" — two notices where the customer needs one. The failure is
          styled as a caveat, not an error: the connection succeeded and read
          access was proven, only the send did not land. */}
      {flashConnected && (
        <p
          role="status"
          className={`w-full max-w-2xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm ${
            testEmailFailed ? "text-muted-foreground" : "text-success"
          }`}
        >
          {params.test_email === "sent"
            ? "Mailbox connected. We've sent a test email to it — check the inbox."
            : testEmailFailed
              ? "Mailbox connected, but we couldn't send its test email. Try Send test email below."
              : "Mailbox connected successfully."}
        </p>
      )}
      {/* An approving administrator no longer lands here at all — they get the
          public /microsoft-approved receipt, because they usually have no Eva
          account and this route would bounce them to sign-in. */}
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
      ) : notEntitled ? (
        <section className="flex w-full max-w-2xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          {/*
            One interpolated string, deliberately — NOT `{organisation.name}`
            followed by JSX text. Next 16's build drops the space between an
            expression and text that wraps onto the following line, so the
            obvious spelling rendered "Malik Test Org Ltddoesn't have…" on
            staging while the source looked correct, and standalone @swc/core
            compiled it correctly. `{" "}` does not survive either: Prettier
            rejoins it on format. Same shape as the "If you arethe
            administrator" defect of 2026-07-31.
          */}
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there's no mailbox to connect yet.`}
          </p>
          <div>
            <Link
              href="/app/settings/modules"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              See your products
            </Link>
          </div>
        </section>
      ) : status ? (
        <section className="flex w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          {status.mailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mailbox connected yet.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {status.mailboxes.length} of {status.seats} {status.seats === 1 ? "seat" : "seats"}{" "}
                in use
              </p>
              {status.mailboxes.map((mailbox) => (
                <MailboxCard
                  key={mailbox.id}
                  mailbox={mailbox}
                  showPrimary={status!.mailboxes.length > 1}
                  actions={
                    <MailboxActions
                      organisationId={organisation.id}
                      mailbox={mailbox}
                      canPromote={status!.mailboxes.length > 1}
                    />
                  }
                />
              ))}
            </>
          )}

          {/* Hidden entirely at the limit rather than shown-and-refused: the
              seat check the API does here is a pre-check for exactly this
              reason — nobody should consent at Microsoft for nothing. */}
          {status.seatLimitReached ? (
            <p className="text-sm text-muted-foreground">
              Every seat is in use. Disconnect one, or add a seat on{" "}
              <Link
                href="/app/settings/modules"
                className="font-medium text-primary hover:underline"
              >
                your products
              </Link>
              , to connect another.
            </p>
          ) : (
            <ConnectMailboxForm
              organisationId={organisation.id}
              defaultAddress={attemptedAddress}
              label={
                status.mailboxes.length === 0
                  ? "Connect Outlook mailbox"
                  : "Connect another mailbox"
              }
            />
          )}
        </section>
      ) : null}

      <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
        Back to your organisations
      </Link>
    </main>
  );
}
