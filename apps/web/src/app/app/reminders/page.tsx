import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReminderActivityDto } from "@eva/types";
import { Card, CounterCard, EmptyState, PageHeader, StatusPill } from "@/components/ui";
import { ApiError, apiFetch } from "@/lib/api";
import { can } from "@/lib/permissions";
import { explainWaiting, stageLabel, statusLabel, statusTone } from "@/lib/reminder-activity";
import { createClient } from "@/lib/supabase/server";
import { dayMonth } from "../week-panel";

/**
 * Chase activity (Slice 1.7; redressed 2026-08-09).
 *
 * ⚠️ THIS SCREEN EXISTS BECAUSE EVA'S WORK WAS INVISIBLE. Every scheduled and
 * sent reminder has been recorded since slice 1.5 and no screen read a single
 * row of it — so "is Eva actually chasing anybody?" could only be answered from
 * the database. A product that works silently and a product that is broken look
 * identical to a customer.
 *
 * The counters are deliberately blunt: sent, waiting, didn't send. Waiting is
 * the one that matters — it is money not being chased — so it is the only one
 * that gets an explanation and a link to the fix.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
}

export default async function RemindersPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Create an organisation first.</p>
      </Shell>
    );
  }

  const header = (
    <PageHeader title="Chasing" subtitle={`What Eva has done for ${organisation.name}.`} />
  );

  // The API's own answer about this caller, never a role name (task 8).
  if (!can(organisation, "reminders:read")) {
    return (
      <Shell>
        {header}
        <p className="text-sm text-muted-foreground">
          Your role cannot see chasing activity. Ask an owner or administrator.
        </p>
      </Shell>
    );
  }

  /**
   * ⚠️ A READ-ONLY SCREEN MUST NOT BE A DEAD END WHEN THE API IS DOWN. There is
   * nothing to lose and nothing to retry here, so a crash would be pure damage:
   * the customer would learn nothing and be able to do nothing. Say what is
   * unknown, keep the navigation, and let them try again.
   */
  let activity: ReminderActivityDto | null = null;
  let loadError: string | null = null;
  try {
    activity = (await (
      await apiFetch(`/organisations/${organisation.id}/reminders/activity`, accessToken)
    ).json()) as ReminderActivityDto;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    loadError =
      error instanceof ApiError
        ? error.message
        : "We couldn't load chasing activity just now. Please try again in a moment.";
  }

  if (!activity) {
    return (
      <Shell>
        {header}
        <Card className="px-6 py-5 text-sm">{loadError}</Card>
        <p className="text-sm text-muted-foreground">
          Reminders that were already scheduled are unaffected — this page only reads them.
        </p>
      </Shell>
    );
  }

  const waiting = explainWaiting(activity.counts.waiting, activity.waitingReason);

  return (
    <Shell>
      {header}

      <div className="flex flex-wrap gap-3">
        <CounterCard value={activity.counts.sentLast7Days} label="Sent" sublabel="last 7 days" />
        <CounterCard
          value={activity.counts.waiting}
          label="Waiting"
          sublabel="due, not yet sent"
          tone="warn"
        />
        <CounterCard
          value={activity.counts.failedLast7Days}
          label="Didn't send"
          sublabel="last 7 days"
          tone="bad"
        />
      </div>

      {waiting && (
        <div className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-warning-border bg-warning-tint px-6 py-4">
          <h2 className="text-[13.5px] font-bold text-warning-strong">{waiting.headline}</h2>
          <p className="text-[13px] text-muted-foreground">{waiting.detail}</p>
          {waiting.fixHref && (
            <Link
              href={waiting.fixHref}
              className="text-[13px] font-semibold text-warning-strong hover:underline"
            >
              {waiting.fixLabel} →
            </Link>
          )}
        </div>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-sm font-bold">Recent activity</h2>
        {activity.recent.length === 0 ? (
          <EmptyState
            headline="Nothing to show yet."
            detail="Reminders appear here once an invoice is overdue enough to chase. Nothing is wrong — Eva simply has not needed to write to anybody."
          />
        ) : (
          <Card className="overflow-x-auto px-6 py-2">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="text-[11.5px] font-semibold tracking-[0.04em] text-faint uppercase">
                  <th className="py-2.5 font-semibold">Date</th>
                  <th className="py-2.5 font-semibold">Client</th>
                  <th className="py-2.5 font-semibold">Invoice</th>
                  <th className="py-2.5 font-semibold">Stage</th>
                  <th className="py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {activity.recent.map((row) => (
                  <tr key={row.id} className="border-t border-hairline text-[13px]">
                    {/* Already a calendar day in the ORG's timezone — sliced,
                        never re-derived. See `dayMonth`. */}
                    <td className="py-3 text-muted-foreground">{dayMonth(row.scheduledDate)}</td>
                    <td className="py-3 font-semibold">{row.customerName}</td>
                    <td className="py-3">
                      <Link
                        href={`/app/clients/${row.customerId}/invoices`}
                        className="text-link hover:underline"
                      >
                        {row.invoiceNumber}
                      </Link>
                    </td>
                    <td className="py-3 text-muted-foreground">{stageLabel(row.stageKey)}</td>
                    <td className="py-3">
                      <StatusPill tone={statusTone(row.status)}>
                        {statusLabel(row.status)}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </Shell>
  );
}

/**
 * ⚠️ THE OLD PER-SCREEN FOOTER LINKS ARE GONE. They predated the shell and one
 * of them still called `/app` "Your account", which it stopped being in slice
 * 1.9. The sidebar is the way around the product now; a second, staler set of
 * links below the fold was only ever a way to get somewhere wrong.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {children}
    </main>
  );
}
