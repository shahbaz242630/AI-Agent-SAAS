import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReminderActivityDto } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { can } from "@/lib/permissions";
import {
  explainWaiting,
  stageLabel,
  statusLabel,
  statusTone,
  summarise,
} from "@/lib/reminder-activity";
import { createClient } from "@/lib/supabase/server";

/**
 * Chase activity (Slice 1.7).
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
        <p className="w-full max-w-3xl text-sm text-muted-foreground">
          Create an organisation first.
        </p>
      </Shell>
    );
  }

  // The API's own answer about this caller, never a role name (task 8).
  if (!can(organisation, "reminders:read")) {
    return (
      <Shell>
        <Header name={organisation.name} />
        <p className="w-full max-w-3xl text-sm text-muted-foreground">
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
        <Header name={organisation.name} />
        <p className="w-full max-w-3xl rounded-[var(--radius-card)] bg-muted px-6 py-5 text-sm">
          {loadError}
        </p>
        <p className="w-full max-w-3xl text-sm text-muted-foreground">
          Reminders that were already scheduled are unaffected — this page only reads them.
        </p>
      </Shell>
    );
  }

  const waiting = explainWaiting(activity.counts.waiting, activity.waitingReason);

  return (
    <Shell>
      <Header name={organisation.name} />

      <section className="flex w-full max-w-3xl flex-col gap-2">
        <p className="text-sm text-muted-foreground">{summarise(activity.counts)}</p>
      </section>

      <section className="grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
        <Counter label="Sent" sublabel="last 7 days" value={activity.counts.sentLast7Days} />
        <Counter label="Waiting" sublabel="due, not yet sent" value={activity.counts.waiting} />
        <Counter
          label="Didn't send"
          sublabel="last 7 days"
          value={activity.counts.failedLast7Days}
        />
      </section>

      {waiting ? (
        <section className="flex w-full max-w-3xl flex-col gap-2 rounded-[var(--radius-card)] bg-muted px-6 py-5">
          <h2 className="text-base font-semibold">{waiting.headline}</h2>
          <p className="text-sm text-muted-foreground">{waiting.detail}</p>
          {waiting.fixHref ? (
            <Link
              href={waiting.fixHref}
              className="text-sm font-medium text-primary hover:underline"
            >
              {waiting.fixLabel}
            </Link>
          ) : null}
        </section>
      ) : null}

      <section className="flex w-full max-w-3xl flex-col gap-3">
        <h2 className="text-base font-semibold">Recent activity</h2>
        {activity.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to show yet. Reminders appear here once an invoice is overdue enough to chase.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Client</th>
                  <th className="py-2 pr-4 font-medium">Invoice</th>
                  <th className="py-2 pr-4 font-medium">Stage</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {activity.recent.map((row) => (
                  <tr key={row.id} className="border-t border-muted">
                    <td className="py-2 pr-4 tabular-nums">{row.scheduledDate}</td>
                    <td className="py-2 pr-4">{row.customerName}</td>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/app/clients/${row.customerId}/invoices`}
                        className="hover:underline"
                      >
                        {row.invoiceNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{stageLabel(row.stageKey)}</td>
                    <td className="py-2">
                      <StatusPill status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

function Header({ name }: { name: string }) {
  return (
    <section className="flex w-full max-w-3xl flex-col gap-2">
      <h1 className="text-2xl font-bold text-primary">Chasing activity</h1>
      <p className="text-sm text-muted-foreground">{`What Eva has done for ${name}.`}</p>
    </section>
  );
}

function Counter({ label, sublabel, value }: { label: string; sublabel: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-muted px-5 py-4">
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{sublabel}</span>
    </div>
  );
}

const TONE_CLASSES: Record<string, string> = {
  good: "bg-success/10 text-success",
  warn: "bg-warning/10 text-warning",
  bad: "bg-destructive/10 text-destructive",
  mute: "bg-muted text-muted-foreground",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[statusTone(status)]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      {children}
      <div className="flex gap-4">
        <Link
          href="/app/invoices"
          className="text-sm font-medium text-muted-foreground hover:underline"
        >
          Invoices
        </Link>
        <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
          Your account
        </Link>
      </div>
    </main>
  );
}
