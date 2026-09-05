import { redirect } from "next/navigation";
import { moduleHref, type ReminderActivityDto } from "@eva/types";
import { AlertCard, EmptyState, GhostLink, PrimaryLink, SectionHeading } from "@/components/ui";
import { ApiError, apiFetch } from "@/lib/api";
import {
  attentionItems,
  owedRows,
  type CurrencyTotal,
} from "@/products/invoice-follow-up/dashboard";
import { firstNameFrom } from "@/lib/identity";
import { can } from "@/lib/permissions";
import { sessionFailureDestination } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { greeting, todayLabel } from "@/lib/today";
import { OwedPanel } from "./owed-panel";
import { WeekPanel } from "./week-panel";

/**
 * This product's own screens, built from the catalogue rather than typed out.
 *
 * ⚠️ ALL FOUR OF THE LINKS BELOW WERE DEAD (found 2026-08-20). This screen is
 * the first thing a customer sees inside Invoice Chasing, and its empty state —
 * the one a brand-new account lands on — offered "Add your first invoice" and
 * "Upload a spreadsheet" pointing at addresses that stopped existing when the
 * products got their own URLs. A new customer's first two clicks were 404s.
 */
const BOOK = moduleHref("email_credit_controller", "invoices");
const IMPORT = moduleHref("email_credit_controller", "invoices/import");
const CHASING = moduleHref("email_credit_controller", "chasing");

/**
 * Home (Slice 1.9; redressed 2026-08-09).
 *
 * ⚠️ THIS REPLACED AN ACCOUNT PAGE. It used to show a name, an email and a list
 * of organisations with their role keys — everything except the number the
 * business actually cares about. The job of this screen is to answer "what am I
 * owed, is Eva chasing it, and does anything need me" without a click.
 *
 * ⚠️ NO SINGLE "YOU ARE OWED" FIGURE, EVER. Minor units are not comparable
 * across currencies, so one big number is a confident lie for any business
 * trading in more than one. Totals are per currency; `products/invoice-follow-up/dashboard.ts` carries
 * the reasoning and the tests.
 *
 * ⚠️ OVERDUE MONEY COMES FROM `matchedByCurrency`, NEVER `chasedByCurrency`.
 * The second is computed from the organisation id alone and ignores the
 * request's filters, so a `?status=overdue` call returns WHOLE-BOOK money —
 * printing that beside the word "overdue" would state something untrue in the
 * one figure a business reads first.
 *
 * ⚠️ THE GREETING AND THE DATE USE THE ORGANISATION'S TIMEZONE. This renders on
 * a server in `us-west2`; its own clock would greet a Manchester customer with
 * "Afternoon" at midnight and print yesterday's date above a book of overdue
 * invoices. See `lib/today.ts`.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  timezone?: string | undefined;
}

interface Book {
  totalCount: number;
  chasedByCurrency: CurrencyTotal[];
  matchedByCurrency: CurrencyTotal[];
}

export default async function AppHomePage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");
  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "";

  let organisations: OrganisationSummary[];
  try {
    organisations = (await (
      await apiFetch("/organisations", accessToken)
    ).json()) as OrganisationSummary[];
  } catch (error) {
    /* Home asks for organisations itself rather than through
       `fetchOrganisations`, so it needs the same idle-session handling — the
       one screen that would otherwise still loop. See `lib/session.ts`. */
    if (error instanceof ApiError && error.status === 401) {
      redirect(sessionFailureDestination(error.code));
    }
    return (
      <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
        <h1 className="font-display text-[29px] font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          {error instanceof ApiError
            ? error.message
            : "We couldn't load your account. Please try again in a moment."}
        </p>
        {/**
         * ⚠️ THE REFERENCE, WHERE A SCREENSHOT WILL CATCH IT. On 2026-08-11
         * this screen said "unexpected error (500)" to the founder for two
         * hours and there was no path from that sentence to the request behind
         * it. The id is the API's own fault-log key: quoting it finds the line.
         * Only shown when there is one — an invented reference is worse than
         * none.
         */}
        {error instanceof ApiError && error.correlationId && (
          <p className="text-[13px] text-faint">Reference: {error.correlationId}</p>
        )}
      </main>
    );
  }

  const organisation = organisations[0];
  // A brand-new account has nothing to look at, so it goes straight into setup —
  // and `showsAppChrome` hides the shell there, because every link would be a
  // dead end for someone with no organisation yet.
  if (!organisation) redirect("/app/onboarding");

  // `?? "Europe/London"` covers a web build newer than the API it is talking to.
  const timezone = organisation.timezone ?? "Europe/London";

  /**
   * Everything below is best-effort and INDEPENDENT. A role that cannot read
   * reminders, or an organisation without Invoice Chasing, must still get a home
   * screen — so each fetch swallows its own failure and the panel it feeds is
   * simply not rendered. A dashboard that 500s because one number is
   * unavailable is worse than a dashboard missing one number.
   */
  const [book, overdue, activity, mailboxConnected] = await Promise.all([
    fetchBook(organisation.id, accessToken),
    fetchOverdue(organisation.id, accessToken),
    fetchActivity(organisation.id, accessToken),
    fetchMailboxConnected(organisation.id, accessToken),
  ]);

  const overdueCount = overdue?.totalCount ?? null;
  const rows = owedRows(book?.chasedByCurrency ?? [], overdue?.matchedByCurrency ?? []);
  const attention = attentionItems({
    mailboxConnected,
    counts: activity?.counts ?? {
      sentLast7Days: 0,
      waiting: 0,
      failedLast7Days: 0,
      scheduled: 0,
    },
    waitingReason: activity?.waitingReason ?? null,
  });
  // An empty book is the first-run state, not an error — and it is the very
  // first thing a new customer sees, so it gets somewhere to go rather than a
  // blank panel.
  const bookIsEmpty = book !== null && rows.length === 0 && book.totalCount === 0;

  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[29px] leading-tight font-semibold">
            {greeting(timezone)}, {firstNameFrom(email)}.
          </h1>
          <p className="text-sm text-muted-foreground">
            What {organisation.name} is owed, and what Eva is doing.
          </p>
        </div>
        <p className="pb-1 text-[13px] text-faint">{todayLabel(timezone)}</p>
      </header>

      {attention.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHeading title="Needs you" />
          <div className="flex flex-wrap gap-3">
            {attention.map((item) => (
              <AlertCard
                key={item.kind}
                tone={item.tone}
                headline={item.headline}
                detail={item.detail}
                {...(item.href && item.linkLabel
                  ? { action: { href: item.href, label: item.linkLabel } }
                  : {})}
              />
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <SectionHeading
          title="What you are owed"
          {...(overdueCount !== null && overdueCount > 0
            ? {
                action: {
                  href: `${BOOK}?status=overdue`,
                  label:
                    overdueCount === 1
                      ? "1 invoice is overdue"
                      : `${overdueCount} invoices are overdue`,
                  tone: "danger" as const,
                },
              }
            : {})}
        />

        {book === null ? (
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load your invoices just now. Nothing is lost — try again in a moment.
          </p>
        ) : bookIsEmpty ? (
          <EmptyState
            headline="Your book is empty."
            detail="Add an invoice or upload a spreadsheet, and Eva starts chasing whatever is left on it — on the schedule you set."
          >
            <PrimaryLink href={BOOK}>Add your first invoice</PrimaryLink>
            <GhostLink href={IMPORT}>Upload a spreadsheet</GhostLink>
          </EmptyState>
        ) : (
          <OwedPanel rows={rows} />
        )}
      </section>

      {activity && can(organisation, "reminders:read") && (
        <section className="flex flex-col gap-2.5">
          <SectionHeading
            title="Eva this week"
            action={{ href: CHASING, label: "See everything Eva sent" }}
          />
          <WeekPanel activity={activity} />
        </section>
      )}
    </main>
  );
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

/**
 * What is overdue — how many, and how much of each currency.
 *
 * ⚠️ THE MONEY MUST COME OFF THIS FILTERED CALL, not the unfiltered one above.
 * `matchedByCurrency` totals exactly what `?status=overdue` selected, so it is
 * the only figure that may be printed under the word "overdue"; `totalCount`
 * from the same response is the matching count, so the two can never disagree.
 */
async function fetchOverdue(organisationId: string, accessToken: string): Promise<Book | null> {
  try {
    return (await (
      await apiFetch(
        `/organisations/${organisationId}/invoices?status=overdue&limit=1`,
        accessToken,
      )
    ).json()) as Book;
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
    /**
     * ⚠️ NAMED FOR THE PRODUCT (slice 3.1c-0), AND IT WAS NOT. Without
     * `module` the api answers 400, and the bare `catch` this had turned
     * that into "could not tell" — so the mailbox nag on this screen was
     * silently off from 2026-09-01 to 2026-09-05, found only because the
     * Clients screen makes the same call without the catch and fell over.
     */
    const body = (await (
      await apiFetch(
        `/organisations/${organisationId}/mailboxes?module=email_credit_controller`,
        accessToken,
      )
    ).json()) as { mailboxes: unknown[] };
    return body.mailboxes.length > 0;
  } catch (error) {
    /**
     * ⚠️ ONLY THE ANSWERS THAT MEAN "COULD NOT TELL" ARE SWALLOWED — no
     * permission, no Invoice Chasing — and an idle session goes where the
     * rest of the page sends it. Anything else (our own bad request, a 500)
     * is a defect, and turning it into `null` is exactly how the one above
     * hid for four days. It reaches the error boundary with its reference.
     */
    if (error instanceof ApiError && error.status === 401) {
      redirect(sessionFailureDestination(error.code));
    }
    if (error instanceof ApiError && (error.status === 402 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}
