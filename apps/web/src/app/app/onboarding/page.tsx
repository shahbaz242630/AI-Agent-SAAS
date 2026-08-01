import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminConsentHelp } from "@/components/admin-consent-help";
import { MailboxCard, type MailboxSummary } from "@/components/mailbox-card";
import { ApiError, apiFetch } from "@/lib/api";
import { mailboxErrorMessage, needsConsentHelp } from "@/lib/mailbox-errors";
import { createClient } from "@/lib/supabase/server";
import { MailboxStep } from "./mailbox-step";
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

const STEP_LABELS = ["Your business", "Your mailbox", "Done"];

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="flex w-full max-w-2xl items-center gap-2 text-xs">
      {STEP_LABELS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li key={label} className="flex flex-1 flex-col gap-1.5">
            <span
              aria-hidden
              className={`h-1 rounded-full ${done || active ? "bg-primary" : "bg-muted"}`}
            />
            <span className={active ? "font-medium" : "text-muted-foreground"}>
              {done ? `${label} ✓` : label}
            </span>
          </li>
        );
      })}
    </ol>
  );
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

  // Single-org app today — the /app list precedent; org switching is a later slice.
  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
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
    <main className="flex flex-1 flex-col items-center gap-8 p-8">
      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">Set up Eva</h1>
        <p className="text-sm text-muted-foreground">
          Two things and you&apos;re done. Eva chases your unpaid invoices from your own mailbox, so
          replies come straight back to you.
        </p>
      </section>

      <StepIndicator current={step} />

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

      <section className="flex w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-card)] bg-muted px-6 py-5">
        {step === 1 && <OrganisationStep />}

        {step === 2 &&
          organisation &&
          (forbidden ? (
            <p className="text-sm text-muted-foreground">
              Your role doesn&apos;t let you connect a mailbox for {organisation.name}. Ask an owner
              or administrator to finish the setup.
            </p>
          ) : (
            <MailboxStep organisationId={organisation.id} defaultAddress={attemptedAddress} />
          ))}

        {step === 3 && status && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-success">You&apos;re set up</h2>
              {/* The test email is sent, not confirmed (founder ruling
                  2026-07-31). It is self-addressed, so it never crosses the
                  internet and cannot realistically fail to arrive once Graph
                  has accepted it — asking "did it arrive?" would be asking
                  something we already know, in a flow whose whole point is
                  having no steps. */}
              <p className="text-sm text-muted-foreground">
                {params.test_email === "sent"
                  ? "We've sent a test email to the address below — it should be in your inbox."
                  : params.test_email === "failed"
                    ? "Your mailbox is connected, but we couldn't send its test email. You can try again from mailbox settings."
                    : "Your mailbox is connected."}
              </p>
            </div>
            {/* Setup connects one, but an organisation that returns here after
                adding more should see what it actually has. */}
            {status.mailboxes.map((mailbox) => (
              <MailboxCard
                key={mailbox.id}
                mailbox={mailbox}
                showPrimary={status.mailboxes.length > 1}
              />
            ))}
            <div className="flex flex-wrap gap-3">
              <Link
                href="/app"
                className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Go to Eva
              </Link>
              <Link
                href="/app/settings/mailbox"
                className="rounded-[var(--radius-card)] bg-background px-4 py-2 text-sm font-medium hover:opacity-80"
              >
                Mailbox settings
              </Link>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
