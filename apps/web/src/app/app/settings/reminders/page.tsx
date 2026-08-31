import { redirect } from "next/navigation";
import type { ReminderSequenceDto } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { can } from "@/lib/permissions";
import { MIN_DAYS_BETWEEN_REMINDERS } from "@/products/invoice-follow-up/reminder-sequence";
import { createClient } from "@/lib/supabase/server";
import { Card, Notice } from "@/components/ui";
import { ReminderStepList } from "./reminder-step-list";
import { StepControls } from "./step-controls";
import { NoOrganisation, SettingsShell } from "../settings-shell";

/**
 * When Eva chases (Slice 1.8; founder ruling 2026-08-08 — "first reminder 3
 * days before due date, user should have option to change this").
 *
 * ⚠️ THE ENGINE WAS ALREADY BUILT AND ONLY THIS WAS MISSING. `PATCH
 * .../reminder-sequence/steps/:stepId` has accepted `offsetDays` and `enabled`
 * since slice 1.5, permission-gated and audited — but no screen ever called it,
 * so a customer could not change their own timing. Worth remembering when
 * something looks unbuilt: check the API before rebuilding it.
 *
 * ⚠️ A CUSTOMER CAN SOFTEN THE LADDER BUT NEVER EXTEND IT. The API edits and
 * disables the six steps; it does not add a seventh. That is the founder's "we
 * are not debt collectors" ruling enforced in code rather than in a policy
 * document, and this screen must not grow an "add a reminder" button.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
}

export default async function ReminderSettingsPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <Frame>
        <NoOrganisation />
      </Frame>
    );
  }

  // The API's own answer about this caller, never a role name (task 8).
  if (!can(organisation, "reminders:read")) {
    return (
      <Frame name={organisation.name}>
        <p className="text-sm text-muted-foreground">
          {`Your role can't see when Eva chases. Ask an owner or administrator.`}
        </p>
      </Frame>
    );
  }

  /**
   * The same reasoning as the activity screen: a settings page that crashes
   * when the API is unreachable teaches the customer nothing and lets them do
   * nothing. Say what is unknown and keep the navigation.
   */
  let sequence: ReminderSequenceDto | null = null;
  let loadError: string | null = null;
  try {
    sequence = (await (
      await apiFetch(`/organisations/${organisation.id}/reminder-sequence`, accessToken)
    ).json()) as ReminderSequenceDto;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    loadError =
      error instanceof ApiError
        ? error.message
        : "We couldn't load your reminder timings just now. Please try again in a moment.";
  }

  if (!sequence) {
    return (
      <Frame name={organisation.name}>
        <Notice>{loadError}</Notice>
        <p className="text-sm text-muted-foreground">
          Your timings are unchanged — this page could not read them, and reads nothing else.
        </p>
      </Frame>
    );
  }

  const canWrite = can(organisation, "reminders:write");
  // Earliest first, so the screen reads in the order a customer experiences it.
  const steps = [...sequence.steps].sort((a, b) => a.offsetDays - b.offsetDays);

  return (
    <Frame name={organisation.name}>
      <Card className="flex flex-col gap-3 px-6 py-5">
        <h2 className="text-base font-semibold">How this works</h2>
        <p className="text-sm">
          Every reminder is timed from the invoice&rsquo;s own due date, so each invoice is chased
          on its own schedule. Eva sends five emails at most, then hands the invoice back to you.
        </p>
        {/*
          ⚠️ SAID BEFORE IT IS DISCOVERED. The scheduler silently pushes
          reminders apart, so a customer who sets two a day apart sees Eva do
          something other than what they typed and reasonably concludes the
          setting is broken.
        */}
        <p className="text-sm text-muted-foreground">
          {`Eva always leaves at least ${MIN_DAYS_BETWEEN_REMINDERS} days between reminders. If you set two closer together than that, she spaces them out rather than sending both at once.`}
        </p>
      </Card>

      {canWrite ? (
        /**
         * ⚠️ ONE CARD OF ROWS, NOT SIX OPEN FORMS (design handoff §13, built
         * 2026-08-11). Every stage used to render its number boxes at once, so
         * the schedule — the thing this screen exists to answer — was spread
         * over a page you had to scroll to the end of before you knew what was
         * on it. Now each stage says when it goes out on one line, and opens
         * only when somebody wants to change it.
         */
        <section className="flex flex-col gap-4">
          <Card className="px-5 py-2 sm:px-7">
            <ol className="flex flex-col">
              {steps.map((step) => (
                <StepControls key={step.id} organisationId={organisation.id} step={step} />
              ))}
            </ol>
          </Card>
          {/*
            ⚠️ THIS IS NOT THE CURRENCY DEFAULT. Changing a timing reschedules
            invoices the customer is ALREADY chasing, in the same transaction as
            the edit. Someone who believes they are setting a default for future
            invoices would be wrong, and would find out from a customer.

            Below the schedule rather than above it: it answers "what happens
            when I change one", which is a question nobody has until they have
            read what there is to change.
          */}
          <p className="max-w-[60ch] text-[13px] leading-[1.55] text-muted-foreground">
            Changing a timing also reschedules the invoices you are already chasing — not just new
            ones. Nothing already sent is affected.
          </p>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <ReminderStepList steps={steps} />
          <p className="text-sm text-muted-foreground">
            {`Your role can see ${organisation.name}'s reminder timings but not change them. Ask an owner or administrator.`}
          </p>
        </section>
      )}
    </Frame>
  );
}

/**
 * ⚠️ ONE FRAME, NOT A `Shell` AND A `Header` YOU HAVE TO REMEMBER TO PAIR.
 * This screen has four exits — no organisation, no permission, the API did not
 * answer, and the schedule itself — and the old split meant three of them
 * opened with `<Shell><Header/>` typed out again. The no-organisation exit was
 * the one that forgot, so the screen a customer meets before they have an
 * organisation was the only settings screen with no heading and no tabs.
 */
function Frame({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <SettingsShell
      title="When Eva chases"
      subtitle={
        name
          ? `The reminder schedule ${name} uses on every invoice.`
          : "The reminder schedule Eva uses on every invoice."
      }
      current="reminders"
    >
      {children}
    </SettingsShell>
  );
}
