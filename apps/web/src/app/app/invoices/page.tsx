import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import {
  bookFilterLine,
  bookTotalLine,
  defaultBookCurrency,
  otherCurrenciesLine,
} from "@/lib/invoice-book";
import { formatMoney } from "@/lib/money";
import { can, readOnlyInvoicesLine } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { AddRowForm } from "./add-row-form";
import { BookRows, type BookRow } from "./book-rows";

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
  /** What this person may do here — resolved by the API, never by us. */
  permissions: string[];
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

  /**
   * Task 8. Three of the six roles can read this book and change nothing in it.
   *
   * ⚠️ TWO SEPARATE PERMISSIONS, and they are not the same question. Uploading
   * a spreadsheet is `imports:write` and typing a row in is `invoices:write` —
   * they happen to move together in the BRD default matrix, and an organisation
   * with a custom mapping can hold one without the other. Asking once and using
   * the answer twice would be a guess that is right by coincidence today.
   */
  const canWrite = can(organisation, "invoices:write");
  const canImport = can(organisation, "imports:write");

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
          {canImport && (
            <Link
              href="/app/invoices/import"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Upload a spreadsheet
            </Link>
          )}
        </div>
      </section>

      {canWrite ? (
        <AddRowForm organisationId={organisation.id} />
      ) : (
        <p className="w-full max-w-6xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-muted-foreground">
          {readOnlyInvoicesLine(organisation.name)}
        </p>
      )}

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
            <button
              type="submit"
              className="rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium"
            >
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
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Rows are a client component because acting on one — paying it,
                  pausing it, cancelling it — opens a panel underneath, and the
                  rules and words for all of that come from
                  `lib/invoice-lifecycle.ts` rather than being restated here. */}
              <BookRows organisationId={organisation.id} rows={book.rows} canWrite={canWrite} />
            </tbody>
          </table>
        </section>
      )}

      {book.totalCount > PAGE_SIZE && (
        <nav className="flex w-full max-w-6xl items-center gap-3 text-sm">
          {page > 1 && (
            <Link
              href={linkTo({ page: String(page - 1) })}
              className="font-medium text-primary hover:underline"
            >
              Previous
            </Link>
          )}
          <span className="text-muted-foreground">
            {`Page ${page} of ${Math.ceil(book.totalCount / PAGE_SIZE)}`}
          </span>
          {page * PAGE_SIZE < book.totalCount && (
            <Link
              href={linkTo({ page: String(page + 1) })}
              className="font-medium text-primary hover:underline"
            >
              Next
            </Link>
          )}
        </nav>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      {children}
      <div className="flex gap-4">
        <Link
          href="/app/clients"
          className="text-sm font-medium text-muted-foreground hover:underline"
        >
          Clients
        </Link>
        <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
          Your account
        </Link>
      </div>
    </main>
  );
}
