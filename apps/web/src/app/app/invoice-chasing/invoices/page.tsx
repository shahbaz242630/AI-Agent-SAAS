import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import {
  bookFilterLine,
  bookMoneyPanel,
  bookTotalLine,
  otherCurrenciesLine,
} from "@/products/invoice-follow-up/invoice-book";
import { defaultInvoiceCurrency } from "@/lib/currencies";
import { formatMoney } from "@/lib/money";
import { can, readOnlyInvoicesLine } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import {
  Card,
  GhostLink,
  Notice,
  PageHeader,
  PageShell,
  PrimaryLink,
  Table,
} from "@/components/ui";
import { AddRowForm } from "./add-row-form";
import type { PickableClient } from "./client-picker";
import { BookRows, type BookRow } from "./book-rows";
import { BOOK_HEADINGS } from "./book-columns";

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

/**
 * This screen's own address, and the upload flow's.
 *
 * ⚠️ THE FILTERS, THE SEARCH BOX AND THE PAGING ALL POINTED AT A 404 (found
 * 2026-08-20). `linkTo` below builds every one of them, and it built them onto
 * `/app/invoices` — the address this screen had before the products got their
 * own URLs. The book itself loaded, because the sidebar's link is built from
 * the catalogue; every control ON the book was dead. That is the worst shape
 * for a defect to take, because the screen looks fine until you use it.
 */
const BOOK = moduleHref("email_credit_controller", "invoices");
const IMPORT = moduleHref("email_credit_controller", "invoices/import");

interface OrganisationSummary {
  id: string;
  name: string;
  /** What this person may do here — resolved by the API, never by us. */
  permissions: string[];
  /** What a new invoice's currency dropdown opens on (task 13). */
  defaultCurrency?: string;
}

interface CurrencyTotal {
  currency: string;
  invoiceCount: number;
  outstandingMinorUnits: number;
}

interface Book {
  rows: BookRow[];
  totalCount: number;
  /** Every currency the org is chasing — the PICKER, and never filtered. */
  chasedByCurrency: CurrencyTotal[];
  /** What the current filters selected, INCLUDING money nobody is collecting. */
  matchedByCurrency: CurrencyTotal[];
  /** The same filters with the uncollectable states removed — the MONEY on screen. */
  collectableByCurrency: CurrencyTotal[];
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

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <PageShell wide>
        <p className="w-full text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-link hover:underline">
            New organisation
          </Link>
        </p>
      </PageShell>
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
      <PageShell wide>
        {/* ⚠️ THAT LINK WAS THE SIXTH COPY OF THE WRONG PRIMARY (2026-08-31).
            Card radius, `text-sm`, `font-medium`, no shadow — the exact shape
            the settings pass replaced five times over, sitting on a screen
            nobody had read side by side with them. `PrimaryLink` navigates, so
            it is the right one here rather than `PrimarySubmit`. */}
        <Card className="flex w-full flex-col gap-3 px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there are no invoices to show yet.`}
          </p>
          <div>
            <PrimaryLink href="/app/settings/modules">See your products</PrimaryLink>
          </div>
        </Card>
      </PageShell>
    );
  }

  if (forbidden || !book) {
    return (
      <PageShell wide>
        <p className="w-full text-sm text-muted-foreground">
          {/* One wording for every refusal in the product — the settings pass
              settled on this on 2026-08-30 and this screen was not in it. */}
          {`Your role can't see invoices for ${organisation.name}. Ask an owner or administrator.`}
        </p>
      </PageShell>
    );
  }

  /**
   * Which currency's money is on screen. Chosen by INVOICE COUNT, never by
   * amount — see `defaultBookCurrency`; comparing minor units across currencies
   * opened this page on three Kuwaiti invoices and hid a sterling book.
   *
   * ⚠️ THREE LISTS, THREE JOBS, AND SWAPPING THEM BREAKS SOMETHING EVERY TIME.
   * The PICKER is the unfiltered `chasedByCurrency`, because its whole purpose
   * is telling someone looking at GBP that there is money in AED — filtering it
   * would collapse it to the currency already chosen. The MONEY is
   * `collectableByCurrency`: it follows the tabs, so it cannot disagree with the
   * list printed beneath it, and it drops the states nobody is collecting, so
   * the word above it stays true. `matchedByCurrency` still holds the
   * uncollectable money, for the headings that ask for it BY NAME.
   *
   * The view is passed in for exactly that last decision, and `bookMoneyPanel`
   * owns it because this page is an async server component no test can render.
   */
  const { currencies, selectedCurrency, money: selected } = bookMoneyPanel(book, currency, status);

  /**
   * The clients the add form's picker offers (founder, 2026-08-18).
   *
   * ⚠️ ITS FAILURE MUST NEVER TAKE THE BOOK DOWN — the dashboard's rule, and it
   * applies with force here because this list is a convenience on ONE form
   * while the table around it is the whole point of the screen. An empty list
   * is also a perfectly ordinary state: a new account has no clients. Either
   * way the picker falls back to plain typing, which is what it replaced.
   */
  let clients: PickableClient[] = [];
  try {
    clients = (await (
      await apiFetch(`/organisations/${organisation.id}/customers`, accessToken)
    ).json()) as PickableClient[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    // Anything else — a role without `customers:read`, a module not entitled —
    // leaves the picker empty and the rest of the screen working.
  }

  const linkTo = (changes: Record<string, string | undefined>): string => {
    const next = new URLSearchParams();
    const merged = { status, search, currency, page: String(page), ...changes };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== "" && !(key === "page" && value === "1")) {
        next.set(key, value);
      }
    }
    const qs = next.toString();
    return qs ? `${BOOK}?${qs}` : BOOK;
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
  /* ⚠️ A THIRD PERMISSION, NOT A REUSE OF `canWrite`. Correcting the person
     Eva writes to is `contacts:write` — a separate grant that a role can hold
     without `invoices:write`, and vice versa. */
  const canEditContacts = can(organisation, "contacts:write");

  return (
    <PageShell wide>
      <PageHeader
        title="Invoices"
        subtitle={`Everything ${organisation.name} is owed, oldest first. Eva chases what is left, never the total.`}
      />

      {canWrite ? (
        <AddRowForm
          organisationId={organisation.id}
          /* No client is in view here, so there is no per-client evidence to
             prefer — the organisation's own default is the best answer. */
          defaultCurrency={defaultInvoiceCurrency({
            organisationDefault: organisation.defaultCurrency,
          })}
          clients={clients}
        >
          {canImport && <GhostLink href={IMPORT}>Upload a spreadsheet</GhostLink>}
        </AddRowForm>
      ) : (
        /* ⚠️ UPLOADING SURVIVES LOSING THE OTHER HALF. `imports:write` and
           `invoices:write` are separate permissions, so a role that may upload
           a spreadsheet but not type a row still needs its button — it just no
           longer has anything to sit beside. */
        /* ⚠️ THE `max-w-6xl` HERE WAS A THIRD WIDTH ON A SCREEN THAT ALREADY
           HAD TWO (removed 2026-08-31) — 1152px, on one branch of one screen,
           so the read-only view of the book was narrower than the writable one
           and nobody could see both at once to notice. */
        <div className="flex w-full flex-col gap-3">
          {canImport && (
            <div className="flex flex-wrap items-center gap-2">
              <GhostLink href={IMPORT}>Upload a spreadsheet</GhostLink>
            </div>
          )}
          <Notice tone="muted">{readOnlyInvoicesLine(organisation.name)}</Notice>
        </div>
      )}

      {/* The money, one currency at a time — with the others named beside it so
          choosing GBP cannot hide the AED (founder's ruling 2026-08-04). It
          counts what the TABS below have selected, and says which that is. */}
      <Card className="flex w-full flex-col gap-2 px-6 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <p className="text-sm font-medium">
            {bookTotalLine({
              currency: selectedCurrency,
              formattedOutstanding: formatMoney(
                selected?.outstandingMinorUnits ?? 0,
                selectedCurrency,
              ),
              invoiceCount: selected?.invoiceCount ?? 0,
              view: status,
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
                      : "border border-input-border bg-surface text-muted-foreground hover:bg-chip-hover"
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
      </Card>

      <section className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {VIEWS.map((view) => (
            <Link
              key={view.key}
              href={linkTo({ status: view.key || undefined, page: "1" })}
              className={`rounded-[var(--radius-card)] px-3 py-1.5 text-xs font-medium ${
                (status ?? "") === view.key
                  ? "bg-primary text-primary-foreground"
                  : "border border-input-border bg-surface hover:bg-chip-hover"
              }`}
            >
              {view.label}
            </Link>
          ))}
          {/* A plain GET form, so a filtered book is a URL somebody can keep. */}
          <form action={BOOK} method="get" className="flex items-center gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            {currency && <input type="hidden" name="currency" value={currency} />}
            <input
              type="search"
              name="search"
              defaultValue={search ?? ""}
              placeholder="Invoice number or client"
              className="rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs"
            />
            <button
              type="submit"
              className="rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs font-semibold hover:bg-chip-hover"
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
        /* ⚠️ THE MINIMUM GREW WITH THE COLUMN COUNT (2026-08-18). Email and
           phone left the client cell and became columns of their own, and a
           1200px floor is what stops the ten of them crushing each other before
           the horizontal scroll takes over. `BOOK_COLUMNS` in `book-rows.tsx`
           is now DERIVED from `BOOK_HEADINGS.length` beside it, so the two can
           no longer disagree — better than a test that notices afterwards. */
        <Table minWidth={1200} columns={BOOK_HEADINGS}>
          {/* Rows are a client component because acting on one — paying it,
              pausing it, cancelling it — opens a panel underneath, and the
              rules and words for all of that come from
              `products/invoice-follow-up/invoice-lifecycle.ts` rather than being restated here. */}
          <BookRows
            organisationId={organisation.id}
            rows={book.rows}
            canWrite={canWrite}
            canEditContacts={canEditContacts}
          />
        </Table>
      )}

      {book.totalCount > PAGE_SIZE && (
        <nav className="flex w-full items-center gap-3 text-sm">
          {page > 1 && (
            <Link
              href={linkTo({ page: String(page - 1) })}
              className="font-medium text-link hover:underline"
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
              className="font-medium text-link hover:underline"
            >
              Next
            </Link>
          )}
        </nav>
      )}
    </PageShell>
  );
}

/*
 * ⚠️ THE OLD PER-SCREEN FOOTER LINKS ARE GONE — the same removal the reminders
 * screen had in slice 1.9, finished here on 2026-08-11 after the founder found
 * the leftovers by walking the product.
 *
 * Three links sat below the fold: "Clients" and "Invoice settings", both of
 * which the sidebar already offers, and "Your account" pointing at `/app` —
 * which stopped being the account page in slice 1.9 and is now Home. A second,
 * staler set of navigation is not redundancy; it is a way to get somewhere
 * other than where the label promised.
 *
 * ⚠️ AND THE WIDTH THIS SCREEN INVENTED NOW LIVES IN THE KIT (2026-08-31). It
 * kept its own 1600px `Shell` while `chasing` next door kept a 1080px copy, so
 * two screens in one product disagreed and neither knew. Both are
 * `PageShell wide` now; the reasoning for 1600 moved to `PageShell` with it.
 */
