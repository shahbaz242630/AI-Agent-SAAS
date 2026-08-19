import { redirect } from "next/navigation";
import { AdminConsentHelp } from "@/components/admin-consent-help";
import { MailboxCard, type MailboxSummary } from "@/components/mailbox-card";
import { GhostLink, PrimaryLink } from "@/components/ui";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { mailboxErrorMessage, needsConsentHelp } from "@/capabilities/mailbox/mailbox-errors";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../actions";
import { MailboxStep } from "./mailbox-step";
import { OnboardingFrame } from "./onboarding-frame";
import { OrganisationStep } from "./organisation-step";

/**
 * Setting Eva up: name the business, connect the mailbox, done.
 *
 * The step is DERIVED from server state on every render — no wizard position is
 * stored anywhere. That is what makes the flow survive the round trip through
 * Microsoft, which takes the browser off our origin entirely and can come back
 * minutes later, on a different tab, or not at all. It also means refreshing,
 * going back, and returning tomorrow all land the customer exactly where they
 * actually are rather than where a cookie thinks they were.
 *
 * ⚠️ THE 2026-08-09 DESIGN DRESSED THIS, IT DID NOT REWIRE IT (slice 1.10d).
 * The handoff's card, rail and stepper are new; the derivation above, the copy,
 * and every refusal branch are the same as they were. The one thing the design
 * asked for and did not get is routing straight to `/app` after connecting:
 * that would delete the only confirmation a new customer ever sees, because the
 * dashboard has no "your mailbox is connected" banner to receive it.
 */

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

export default async function OnboardingPage({
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
  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "";

  // Single-org app today — the /app list precedent; org switching is a later slice.
  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  let status: { mailboxes: MailboxSummary[] } | null = null;
  let forbidden = false;
  if (organisation) {
    try {
      status = (await (
        await apiFetch(`/organisations/${organisation.id}/mailboxes`, accessToken)
      ).json()) as { mailboxes: MailboxSummary[] };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      // 403 (role) and 402 (product not held) both mean "this person cannot
      // finish setup here" — the message below covers the first, and the
      // second cannot happen during signup because organisation creation
      // grants the module in the same transaction.
      if (error instanceof ApiError && (error.status === 403 || error.status === 402))
        forbidden = true;
      else throw error;
    }
  }

  const errorCode = typeof params.error === "string" ? params.error : null;
  const attemptedAddress = typeof params.hint === "string" ? params.hint : null;
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
  const connected = (status?.mailboxes.length ?? 0) > 0;
  const step = !organisation ? 1 : !connected ? 2 : 3;

  return (
    <OnboardingFrame
      current={step}
      organisationName={organisation?.name ?? null}
      email={email}
      signOutSlot={
        <form action={signOut} className="flex">
          <button
            type="submit"
            className="cursor-pointer text-muted-foreground underline hover:text-foreground"
          >
            Sign out
          </button>
        </form>
      }
      paneTitle={step === 1 ? "Your business" : step === 2 ? "Your mailbox" : "You're set up"}
    >
      {/*
       * A failed connection is the most important thing on the pane, so it goes
       * above the question rather than under it. The padding pair adds up to the
       * pane's own 22px rhythm once the step below adds its 4px.
       */}
      {(flashError || showConsentHelp) && (
        <div className="flex flex-col gap-3 pt-[18px] pb-[18px]">
          {flashError && (
            <p
              role="alert"
              className="rounded-[var(--radius-card)] border border-danger-border bg-danger-surface px-4 py-3 text-[13px] text-danger"
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
        </div>
      )}

      {step === 1 && <OrganisationStep />}

      {step === 2 &&
        organisation &&
        (forbidden ? (
          <p className="pt-1 text-[13.5px] text-muted-foreground">
            Your role doesn&apos;t let you connect a mailbox for {organisation.name}. Ask an owner
            or administrator to finish the setup.
          </p>
        ) : (
          <MailboxStep organisationId={organisation.id} defaultAddress={attemptedAddress} />
        ))}

      {step === 3 && status && (
        <div className="flex flex-1 flex-col pt-1">
          {/* The test email is sent, not confirmed (founder ruling
              2026-07-31). It is self-addressed, so it never crosses the
              internet and cannot realistically fail to arrive once Graph
              has accepted it — asking "did it arrive?" would be asking
              something we already know, in a flow whose whole point is
              having no steps. */}
          <p className="text-[13.5px] text-muted-foreground">
            {params.test_email === "sent"
              ? "We've sent a test email to the address below — it should be in your inbox."
              : params.test_email === "failed"
                ? "Your mailbox is connected, but we couldn't send its test email. You can try again from mailbox settings."
                : "Your mailbox is connected."}
          </p>

          {/* Setup connects one, but an organisation that returns here after
              adding more should see what it actually has. */}
          <div className="flex flex-col gap-3 pt-[22px]">
            {status.mailboxes.map((mailbox) => (
              <MailboxCard
                key={mailbox.id}
                mailbox={mailbox}
                showPrimary={status.mailboxes.length > 1}
              />
            ))}
          </div>

          <div className="min-h-8 flex-1" />

          <div className="flex flex-wrap justify-end gap-3">
            <GhostLink href="/app/settings/mailbox">Mailbox settings</GhostLink>
            <PrimaryLink href="/app">Go to Eva</PrimaryLink>
          </div>
        </div>
      )}
    </OnboardingFrame>
  );
}
