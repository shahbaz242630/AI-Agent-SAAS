import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import {
  ageingBucketLabel,
  bookFilterLine,
  bookTotalLine,
  chaseTimingLine,
  defaultBookCurrency,
  otherCurrenciesLine,
} from "@/lib/invoice-book";
import { chaseBlockedLine, isBeingChased } from "@/lib/invoice-lifecycle";
import { invoiceStatusLabel, invoiceStatusTone, type InvoiceStatusTone } from "@/lib/invoice-status";
import { formatDueDate, formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

/**
 * The whole book — every client's invoices on one screen (slice 1.6c, task 9).
 *
 * ⚠️ THIS SCREEN COMPUTES NOTHING. Every amount, balance, status, ageing bucket
 * and chase date arrives derived from the API: the balance because a third
 * number can disagree with the other two, the status and the bucket because
 * both depend on the ORGANISATION's timezone, and whether Eva will chase
 * because that answer belongs to the scheduler. Work any of them out here and
 * the screen starts disagreeing with the thing that acts on them.
 *
 * ⚠️ FILTERS LIVE IN THE URL, deliberately. It makes "what is overdue right
 * now" a link somebody can bookmark, and it keeps the filter and the page in
 * step — filtering in the browser after paging would show nine of a page of
 * fifty and a count that disagreed with both.
 */

const PAGE_SIZE = 50;

interface OrganisationSummary {
  id: string;
  name: string;
}

interface BookRow {
  id: string;
  invoiceNumber: string;
  description: string | null;
  amountMinorUnits: number;
  amountPaidMinorUnits: number;
  outstandingMinorUnits: number;
  currency: string;
  dueDate: string;
  status: string;
  displayStatus: string;
  chaseBlockedReason: string | null;
  ageingBucket: string;
  lastChasedOn: string | null;
  nextChaseOn: string | null;
  customer: { id: string; name: string; reference: string | null };
  contact: { id: string; name: string; email: string | null; phone: string | null } | null;
}

interface Book {
  rows: BookRow[];
  totalCount: number;
  chasedByCurrency: { currency: string; invoiceCount: number; outstandingMinorUnits: number }[];
}

/** The quick filters, in the order a credit controller works through them. */
const VIEWS = [
  { key: "", label: "Everything" },
  { key: "overdue", label: "Overdue" },
  { key: "due_today", label: "Due today" },
  { key: "due_soon", label: "Due soon" },
  { key: "draft", label: "Drafts" },
] as const;

export default async function InvoiceBookPage({
  searchParams,
}: {
  // Next 16: `searchParams` is a Promise and must be awaited.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const status = single("status");
  const search = single("search");
  const currency = single("currency");
  const page = Math.max(Number(single("page") ?? "1") || 1, 1);

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
        <p className="w-full max-w-6xl text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-primary hover:underline">
            New organisation
          </Link>
        </p>
      </Shell>
    );
  }

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (search) query.set("search", search);
  if (currency) query.set("currency", currency);
  query.set("limit", String(PAGE_SIZE));
  query.set("offset", String((page - 1) * PAGE_SIZE));

  let book: Book | null = null;
  let forbidden = false;
  let notEntitled = false;
  try {
    book = (await (
      await apiFetch(`/organisations/${organisation.id}/invoices?${query.toString()}`, accessToken)
    ).json()) as Book;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  if (notEntitled) {
    return (
      <Shell>
        <section className="flex w-full max-w-6xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there are no invoices to show yet.`}
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
      </Shell>
    );
  }

  if (forbidden || !book) {
    return (
      <Shell>
        <p className="w-full max-w-6xl text-sm text-muted-foreground">
          {`Your role doesn't have access to invoices for ${organisation.name}. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  /**
   * Which currency's money is on screen. Chosen by INVOICE COUNT, never by
   * amount — see `defaultBookCurrency`; comparing minor units across currencies
   * opened this page on three Kuwaiti invoices and hid a sterling book.
   */
  const currencies = book.chasedByCurrency;
  const selectedCurrency = defaultBookCurrency(currencies, currency);
  const selected = currencies.find((row) => row.currency === selectedCurrency);

  const linkTo = (changes: Record<string, string | undefined>): string => {
    const next = new URLSearchParams();
    const merged = { status, search, currency, page: String(page), ...changes };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== "" && !(key === "page" && value === "1")) {
        next.set(key, value);
      }
    }
    const qs = next.toString();
    return qs ? `/app/invoices?${qs}` : "/app/invoices";
  };

  return (
    <Shell>
      <section className="flex w-full max-w-6xl flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold text-primary">Invoices</h1>
            <p className="text-sm text-muted-foreground">
              {`Everything ${organisation.name} is owed, oldest first. Eva chases what is left, never the total.`}
            </p>
          </div>
          <Link
            href="/app/invoices/import"
            className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Upload a spreadsheet
          </Link>
        </div>
      </section>

      {/* The money, one currency at a time — with the others named beside it so
          choosing GBP cannot hide the AED (founder's ruling 2026-08-04). */}
      <section className="flex w-full max-w-6xl flex-col gap-2 rounded-[var(--radius-card)] bg-muted px-6 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <p className="text-sm font-medium">
            {bookTotalLine({
              currency: selectedCurrency,
              formattedOutstanding: formatMoney(
                selected?.outstandingMinorUnits ?? 0,
                selectedCurrency,
              ),
              invoiceCount: selected?.invoiceCount ?? 0,
            })}
          </p>
          {currencies.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {currencies.map((row) => (
                <Link
                  key={row.currency}
                  href={linkTo({ currency: row.currency, page: "1" })}
                  className={`rounded-[var(--radius-card)] px-2 py-1 text-xs font-medium ${
                    row.currency === selectedCurrency
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:opacity-80"
                  }`}
                >
                  {row.currency}
                </Link>
              ))}
            </div>
          )}
        </div>
        {otherCurrenciesLine(currencies, selectedCurrency) && (
          <p className="text-xs text-muted-foreground">
            {otherCurrenciesLine(currencies, selectedCurrency)}
          </p>
        )}
      </section>

      <section className="flex w-full max-w-6xl flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {VIEWS.map((view) => (
            <Link
              key={view.key}
              href={linkTo({ status: view.key || undefined, page: "1" })}
              className={`rounded-[var(--radius-card)] px-3 py-1.5 text-xs font-medium ${
                (status ?? "") === view.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted hover:opacity-80"
              }`}
            >
              {view.label}
            </Link>
          ))}
          {/* A plain GET form, so a filtered book is a URL somebody can keep. */}
          <form action="/app/invoices" method="get" className="flex items-center gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            {currency && <input type="hidden" name="currency" value={currency} />}
            <input
              type="search"
              name="search"
              defaultValue={search ?? ""}
              placeholder="Invoice number or client"
              className="rounded-[var(--radius-card)] border border-muted-foreground/20 px-3 py-1.5 text-xs"
            />
            <button type="submit" className="rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium">
              Search
            </button>
          </form>
        </div>

        <p className="text-sm text-muted-foreground">
          {bookFilterLine({
            totalCount: book.totalCount,
            showing: book.rows.length,
            status,
            search,
          })}
        </p>
      </section>

      {book.rows.length > 0 && (
        <section className="w-full max-w-6xl overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-muted text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Invoice</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Chasing</th>
              </tr>
            </thead>
            <tbody>
              {book.rows.map((row) => {
                const chased = isBeingChased(row.status, row.chaseBlockedReason);
                return (
                  <tr key={row.id} className="border-b border-muted/50 align-top">
                    <td className="px-3 py-3">
                      <Link
                        href={`/app/clients/${row.customer.id}/invoices`}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.customer.name}
                      </Link>
                      {/* Who Eva actually writes to — the reason this column is
                          the contact's address and not the client record's. */}
                      {row.contact?.email && (
                        <span className="block text-xs text-muted-foreground">
                          {row.contact.email}
                        </span>
                      )}
                      {row.contact?.phone && (
                        <span className="block text-xs text-muted-foreground">
                          {row.contact.phone}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-medium">{row.invoiceNumber}</span>
                      {row.description && (
                        <span className="block text-xs text-muted-foreground">
                          {row.description}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {formatDueDate(row.dueDate)}
                      <span className="block text-xs text-muted-foreground">
                        {ageingBucketLabel(row.ageingBucket)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {formatMoney(row.amountMinorUnits, row.currency)}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {/* Bold only when Eva is really collecting it — a
                          cancelled invoice's arithmetic balance is not money
                          anybody is working on. */}
                      <span
                        className={
                          chased && row.outstandingMinorUnits > 0
                            ? "font-medium"
                            : "text-muted-foreground"
                        }
                      >
                        {formatMoney(row.outstandingMinorUnits, row.currency)}
                      </span>
                      {row.amountPaidMinorUnits > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          {`${formatMoney(row.amountPaidMinorUnits, row.currency)} paid`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={row.displayStatus} />
                      {chaseBlockedLine(row.status, row.chaseBlockedReason) && (
                        <span className="mt-1 block max-w-[14rem] text-xs whitespace-normal text-danger">
                          {chaseBlockedLine(row.status, row.chaseBlockedReason)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                      {chaseTimingLine({
                        isChased: chased,
                        lastChasedOn: row.lastChasedOn,
                        nextChaseOn: row.nextChaseOn,
                        formatDate: (value) => formatDueDate(value),
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/*
            ⚠️ NO TOTAL ROW HERE EITHER (trap 3b). The money is stated once, in
            one currency, at the top. A column footer would have to add AED to
            GBP to fill itself in.
          */}
        </section>
      )}

      {book.totalCount > PAGE_SIZE && (
        <nav className="flex w-full max-w-6xl items-center gap-3 text-sm">
          {page > 1 && (
            <Link href={linkTo({ page: String(page - 1) })} className="font-medium text-primary hover:underline">
              Previous
            </Link>
          )}
          <span className="text-muted-foreground">
            {`Page ${page} of ${Math.ceil(book.totalCount / PAGE_SIZE)}`}
          </span>
          {page * PAGE_SIZE < book.totalCount && (
            <Link href={linkTo({ page: String(page + 1) })} className="font-medium text-primary hover:underline">
              Next
            </Link>
          )}
        </nav>
      )}
    </Shell>
  );
}

/**
 * ⚠️ ONLY TOKENS THAT EXIST IN `packages/design-system/tokens.css` — there is
 * no `destructive`, the palette calls it `danger`, and an unknown Tailwind
 * class produces no CSS and no error anywhere.
 */
const TONE_CLASSES: Record<InvoiceStatusTone, string> = {
  urgent: "bg-danger/10 text-danger",
  attention: "bg-warning/10 text-warning",
  positive: "bg-success/10 text-success",
  neutral: "bg-muted text-foreground",
  muted: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-[var(--radius-card)] px-2 py-1 text-xs font-medium ${TONE_CLASSES[invoiceStatusTone(status)]}`}
    >
      {invoiceStatusLabel(status)}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      {children}
      <div className="flex gap-4">
        <Link href="/app/clients" className="text-sm font-medium text-muted-foreground hover:underline">
          Clients
        </Link>
        <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
          Your account
        </Link>
      </div>
    </main>
  );
}
