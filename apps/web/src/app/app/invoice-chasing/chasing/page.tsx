import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReminderActivityDto } from "@eva/types";
import {
  Card,
  CounterCard,
  EmptyState,
  PageHeader,
  PageShell,
  StatusPill,
  Table,
  TableCell,
  TableRow,
  type TableColumn,
} from "@/components/ui";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { can } from "@/lib/permissions";
import {
  describeNoHistoryYet,
  explainWaiting,
  stageLabel,
  statusLabel,
  statusTone,
} from "@/products/invoice-follow-up/reminder-activity";
import { createClient } from "@/lib/supabase/server";
import { dayMonth } from "../week-panel";

/**
 * ⚠️ THE TWO TABLES ON THIS SCREEN SHARE FOUR COLUMNS AND THE HISTORY ADDS ONE.
 * Declared once each rather than typed inline twice, which is how the plan and
 * the history could have drifted from each other the way this screen drifted
 * from the book.
 */
const ACTIVITY_COLUMNS: readonly TableColumn[] = [
  { label: "Date" },
  { label: "Client" },
  { label: "Invoice" },
  { label: "Stage" },
];

const HISTORY_COLUMNS: readonly TableColumn[] = [...ACTIVITY_COLUMNS, { label: "Status" }];

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

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <PageShell wide>
        <p className="text-sm text-muted-foreground">Create an organisation first.</p>
      </PageShell>
    );
  }

  const header = (
    <PageHeader title="Chasing" subtitle={`What Eva has done for ${organisation.name}.`} />
  );

  // The API's own answer about this caller, never a role name (task 8).
  if (!can(organisation, "reminders:read")) {
    return (
      <PageShell wide>
        {header}
        <p className="text-sm text-muted-foreground">
          Your role can&apos;t see chasing activity. Ask an owner or administrator.
        </p>
      </PageShell>
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
      <PageShell wide>
        {header}
        <Card className="px-6 py-5 text-sm">{loadError}</Card>
        <p className="text-sm text-muted-foreground">
          Reminders that were already scheduled are unaffected — this page only reads them.
        </p>
      </PageShell>
    );
  }

  const waiting = explainWaiting(activity.counts.waiting, activity.waitingReason);
  const emptyHistory = describeNoHistoryYet({
    scheduled: activity.counts.scheduled,
    noWorkingMailbox: activity.noWorkingMailbox,
    nextDate: activity.upcoming[0]?.scheduledDate ?? null,
    formatDate: dayMonth,
  });

  return (
    <PageShell wide>
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
        {/* ⚠️ NO TONE. The other three are news about the past — two of them
            things to act on. This one is just the size of the plan, and
            colouring it would make a healthy book look like it needed
            attention. */}
        <CounterCard value={activity.counts.scheduled} label="Scheduled" sublabel="still to come" />
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

      {/* ⚠️ WHAT IS COMING SITS ABOVE WHAT HAPPENED, and that is the point of
          the section rather than a layout preference. The question a customer
          brings to this screen is "is Eva going to chase my money", which is
          about the future; the history is how they check the answer afterwards.
          For every new customer the history is empty and the plan is not. */}
      {activity.upcoming.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-sm font-bold">What Eva will do next</h2>

          {activity.noWorkingMailbox && (
            <div className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-warning-border bg-warning-tint px-6 py-4">
              <h3 className="text-[13.5px] font-bold text-warning-strong">
                None of these can go out yet
              </h3>
              <p className="text-[13px] text-muted-foreground">
                No mailbox is connected, so Eva has nowhere to send from. Nothing is lost — connect
                one and these send on their day as planned.
              </p>
              <Link
                href="/app/settings/mailbox"
                className="text-[13px] font-semibold text-warning-strong hover:underline"
              >
                Connect a mailbox →
              </Link>
            </div>
          )}

          <Table minWidth={640} columns={ACTIVITY_COLUMNS}>
            {activity.upcoming.map((row) => (
              <TableRow key={row.id}>
                {/* Already a calendar day in the ORG's timezone. */}
                <TableCell className="text-muted-foreground">
                  {dayMonth(row.scheduledDate)}
                </TableCell>
                <TableCell className="font-semibold">{row.customerName}</TableCell>
                <TableCell>
                  <Link
                    href={`/app/clients/${row.customerId}/invoices`}
                    className="text-link hover:underline"
                  >
                    {row.invoiceNumber}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{stageLabel(row.stageKey)}</TableCell>
              </TableRow>
            ))}
          </Table>

          {/* ⚠️ NO SILENT TRUNCATION. The list is the near horizon; the count
              is the whole plan, and a reader who sees ten rows must not be left
              believing that is all of it. */}
          {activity.counts.scheduled > activity.upcoming.length && (
            <p className="text-[13px] text-muted-foreground">
              The next {activity.upcoming.length} of {activity.counts.scheduled} reminders Eva has
              scheduled.
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-sm font-bold">Recent activity</h2>
        {activity.recent.length === 0 ? (
          <EmptyState {...emptyHistory} />
        ) : (
          <Table minWidth={640} columns={HISTORY_COLUMNS}>
            {activity.recent.map((row) => (
              <TableRow key={row.id}>
                {/* Already a calendar day in the ORG's timezone — sliced,
                    never re-derived. See `dayMonth`. */}
                <TableCell className="text-muted-foreground">
                  {dayMonth(row.scheduledDate)}
                </TableCell>
                <TableCell className="font-semibold">{row.customerName}</TableCell>
                <TableCell>
                  <Link
                    href={`/app/clients/${row.customerId}/invoices`}
                    className="text-link hover:underline"
                  >
                    {row.invoiceNumber}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{stageLabel(row.stageKey)}</TableCell>
                <TableCell>
                  <StatusPill tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusPill>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>
    </PageShell>
  );
}

/*
 * ⚠️ THE OLD PER-SCREEN FOOTER LINKS ARE GONE. They predated the shell and one
 * of them still called `/app` "Your account", which it stopped being in slice
 * 1.9. The sidebar is the way around the product now; a second, staler set of
 * links below the fold was only ever a way to get somewhere wrong.
 *
 * The local `Shell` that carried that note is gone too (2026-08-31). It was a
 * hand-typed copy of `PageShell` — identical to the day it was written, which
 * is exactly how it escaped notice while the book next door drifted to 1600.
 */
