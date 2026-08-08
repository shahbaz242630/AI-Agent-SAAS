import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReminderActivityDto } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { attentionItems, chaseSummary, owedRows, type CurrencyTotal } from "@/lib/dashboard";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";
import { OwedPanel } from "./owed-panel";

/**
 * Home (Slice 1.9).
 *
 * ⚠️ THIS REPLACED AN ACCOUNT PAGE. It used to show a name, an email and a list
 * of organisations with their role keys — everything except the number the
 * business actually cares about. The job of this screen is to answer "what am I
 * owed, is Eva chasing it, and does anything need me" without a click.
 *
 * ⚠️ NO SINGLE "YOU ARE OWED" FIGURE, EVER. Minor units are not comparable
 * across currencies, so one big number is a confident lie for any business
 * trading in more than one. Totals are per currency; `lib/dashboard.ts` carries
 * the reasoning and the tests.
 *
 * ⚠️ OVERDUE IS A COUNT, NOT AN AMOUNT, AND THAT IS DELIBERATE. The API's
 * `chasedByCurrency` is computed from the organisation id alone and **ignores
 * the request's filters**, so a `?status=overdue` call returns whole-book money
 * that would be wrong under an "overdue" heading. `totalCount` IS filtered, so
 * the honest thing available today is how MANY are overdue. Showing an amount
 * needs an overdue-by-currency total from the API — worth adding, not worth
 * faking.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
}

interface Book {
  totalCount: number;
  chasedByCurrency: CurrencyTotal[];
}

export default async function AppHomePage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  let organisations: OrganisationSummary[];
  try {
    organisations = (await (
      await apiFetch("/organisations", accessToken)
    ).json()) as OrganisationSummary[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return (
      <Shell>
        <section className="flex w-full max-w-4xl flex-col gap-3">
          <h1 className="text-2xl font-bold text-primary">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            {error instanceof ApiError
              ? error.message
              : "We couldn't load your account. Please try again in a moment."}
          </p>
        </section>
      </Shell>
    );
  }

  const organisation = organisations[0];
  // A brand-new account has nothing to look at, so it goes straight into setup —
  // and `showsAppChrome` hides the nav there, because every link would be a dead
  // end for someone with no organisation yet.
  if (!organisation) redirect("/app/onboarding");

  /**
   * Everything below is best-effort and INDEPENDENT. A role that cannot read
   * reminders, or an organisation without Invoice Chasing, must still get a home
   * screen — so each fetch swallows its own failure and the panel it feeds is
   * simply not rendered. A dashboard that 500s because one number is
   * unavailable is worse than a dashboard missing one number.
   */
  const [book, overdueCount, activity, mailboxConnected] = await Promise.all([
    fetchBook(organisation.id, accessToken),
    fetchOverdueCount(organisation.id, accessToken),
    fetchActivity(organisation.id, accessToken),
    fetchMailboxConnected(organisation.id, accessToken),
  ]);

  const rows = owedRows(book?.chasedByCurrency ?? []);
  const attention = activity
    ? attentionItems({
        mailboxConnected,
        counts: activity.counts,
        waitingReason: activity.waitingReason,
      })
    : attentionItems({
        mailboxConnected,
        counts: { sentLast7Days: 0, waiting: 0, failedLast7Days: 0 },
        waitingReason: null,
      });

  return (
    <Shell>
      <header className="flex w-full max-w-4xl items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-primary">{organisation.name}</h1>
          <p className="text-sm text-muted-foreground">What you are owed, and what Eva is doing.</p>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-[var(--radius-card)] bg-muted px-4 py-2 text-sm font-medium hover:opacity-80"
          >
            Sign out
          </button>
        </form>
      </header>

      {attention.length > 0 && (
        <section className="flex w-full max-w-4xl flex-col gap-3">
          <h2 className="text-base font-semibold">Needs you</h2>
          {attention.map((item) => (
            <div
              key={item.kind}
              className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-muted px-6 py-4"
            >
              <span className="text-sm font-semibold">{item.headline}</span>
              <p className="text-sm text-muted-foreground">{item.detail}</p>
              {item.href && (
                <Link href={item.href} className="text-sm font-medium text-primary hover:underline">
                  {item.linkLabel}
                </Link>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="flex w-full max-w-4xl flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">What you are owed</h2>
          {overdueCount !== null && overdueCount > 0 && (
            <Link
              href="/app/invoices?status=overdue"
              className="text-sm font-medium text-danger hover:underline"
            >
              {overdueCount === 1 ? "1 invoice is overdue" : `${overdueCount} invoices are overdue`}
            </Link>
          )}
        </div>

        {book === null ? (
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load your invoices just now. Nothing is lost — try again in a moment.
          </p>
        ) : (
          <OwedPanel rows={rows} />
        )}
      </section>

      {activity && can(organisation, "reminders:read") && (
        <section className="flex w-full max-w-4xl flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Eva this week</h2>
            <Link
              href="/app/reminders"
              className="text-sm font-medium text-primary hover:underline"
            >
              See everything Eva sent
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">{chaseSummary(activity.counts)}</p>
          <div className="grid grid-cols-3 gap-3">
            <Counter label="Sent" value={activity.counts.sentLast7Days} />
            <Counter label="Waiting" value={activity.counts.waiting} />
            <Counter label="Didn't send" value={activity.counts.failedLast7Days} />
          </div>
        </section>
      )}
    </Shell>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-muted px-5 py-4">
      <span className="text-xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center gap-8 p-8">{children}</main>;
}

/** The book, for its per-currency totals. Unfiltered on purpose (see the header). */
async function fetchBook(organisationId: string, accessToken: string): Promise<Book | null> {
  try {
    // limit=1 because only the totals are wanted; the rows are the book screen's job.
    return (await (
      await apiFetch(`/organisations/${organisationId}/invoices?limit=1`, accessToken)
    ).json()) as Book;
  } catch {
    return null;
  }
}

/** How many invoices are overdue. A COUNT — `totalCount` respects the filter. */
async function fetchOverdueCount(
  organisationId: string,
  accessToken: string,
): Promise<number | null> {
  try {
    const book = (await (
      await apiFetch(
        `/organisations/${organisationId}/invoices?status=overdue&limit=1`,
        accessToken,
      )
    ).json()) as Book;
    return book.totalCount;
  } catch {
    return null;
  }
}

async function fetchActivity(
  organisationId: string,
  accessToken: string,
): Promise<ReminderActivityDto | null> {
  try {
    return (await (
      await apiFetch(`/organisations/${organisationId}/reminders/activity`, accessToken)
    ).json()) as ReminderActivityDto;
  } catch {
    return null;
  }
}

/**
 * `null` means we could not tell — no permission, or no Invoice Chasing. That is
 * NOT the same as "no mailbox", and `attentionItems` only nags on an explicit
 * `false`.
 */
async function fetchMailboxConnected(
  organisationId: string,
  accessToken: string,
): Promise<boolean | null> {
  try {
    const body = (await (
      await apiFetch(`/organisations/${organisationId}/mailboxes`, accessToken)
    ).json()) as { mailboxes: unknown[] };
    return body.mailboxes.length > 0;
  } catch {
    return null;
  }
}
