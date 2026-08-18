/**
 * The whole book, in words (slice 1.6c, task 9 — the founder's one table).
 *
 * A pure module in `lib` for the `mailbox-messages.ts` reason: every line here
 * has a singular, a plural or an empty branch, and this project has shipped
 * "lowering to 1 seats" through a fully green gate. Testable without rendering.
 */

/** Ageing by due date — `DATA-MODEL-REVIEW.md` §4's buckets, as the API sends them. */
export const AGEING_BUCKETS = [
  "current",
  "days_1_15",
  "days_16_30",
  "days_31_45",
  "days_over_45",
] as const;

export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/**
 * ⚠️ "Not due yet" RATHER THAN "Current". The accounting word for this bucket
 * is "current", which to everybody else reads as "the current one" — the
 * opposite of what it means. The whole column is about how late money is, so
 * the label says that.
 */
const BUCKET_LABELS: Readonly<Record<AgeingBucket, string>> = {
  current: "Not due yet",
  days_1_15: "1–15 days late",
  days_16_30: "16–30 days late",
  days_31_45: "31–45 days late",
  days_over_45: "Over 45 days late",
};

export function ageingBucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket as AgeingBucket] ?? "Unknown";
}

/**
 * Which currency's money to show when nobody has chosen one.
 *
 * ⚠️ RANKED BY INVOICE COUNT, NEVER BY AMOUNT — and the first version got this
 * wrong on screen. Minor-unit integers are NOT comparable across currencies:
 * KWD has three decimals, so 4,750.499 KWD is 4,750,499 fils, while £1,500.00
 * is 150,000 pence. Sorting by "biggest number" therefore opened the founder's
 * book on its three Kuwaiti invoices and hid a book that is mostly sterling.
 *
 * Comparing money across currencies is the single thing this slice exists to
 * stop, and it crept into the one place that looked like presentation rather
 * than arithmetic. A COUNT has no units, so it can be compared; ties break
 * alphabetically so the answer is stable rather than dependent on row order.
 */
export function defaultBookCurrency(
  currencies: readonly { currency: string; invoiceCount: number }[],
  requested?: string,
): string {
  if (requested) return requested.toUpperCase();
  const ranked = [...currencies].sort(
    (a, b) => b.invoiceCount - a.invoiceCount || a.currency.localeCompare(b.currency),
  );
  return ranked[0]?.currency ?? "GBP";
}

/** One currency's slice of the book, as the API returns it. */
export interface CurrencyTotal {
  currency: string;
  invoiceCount: number;
  outstandingMinorUnits: number;
}

/**
 * The views whose own heading ASKS for money nobody is collecting.
 *
 * ⚠️ ONLY THESE MAY BE TOTALLED FROM `matchedByCurrency`. Under "Drafts" or
 * "Cancelled" the reader asked for exactly that money and the heading says so,
 * which makes the figure honest. Under ANY other heading — above all the
 * unfiltered one — the same figure becomes a claim about what the business is
 * owed, and a cancelled invoice is not that.
 */
const NON_COLLECTING_VIEWS: ReadonlySet<string> = new Set(["draft", "cancelled"]);

/**
 * Which list feeds the picker and which feeds the figure.
 *
 * ⚠️ THIS EXISTS TO MAKE THE MOST BREAKABLE DECISION ON THE SCREEN TESTABLE.
 * The API returns two per-currency lists and they are trivially swappable —
 * both are arrays of the same shape, so putting the wrong one in either place
 * typechecks, lints and looks right. Left inline in `page.tsx` the choice could
 * not be covered at all, because that page is an async server component doing
 * auth and fetches. Here it is four lines of pure logic with a test.
 *
 * - The PICKER is the UNFILTERED list. Its whole job is telling someone looking
 *   at GBP that there is money in AED; building it from the filtered list would
 *   collapse it to the currency already chosen and hide the rest of the book.
 * - The FIGURE is the FILTERED list, because it sits above a table the view
 *   tabs filter, and whole-book money over an "Overdue" list reads as two
 *   numbers disagreeing. WHICH filtered list depends on the heading — below.
 *
 * ⚠️ A THIRD LIST EXISTS BECAUSE "FILTERED" WAS NOT ENOUGH. `matched` follows
 * the tabs, which made it look correct under every heading — but the
 * unfiltered "Everything" tab is the ONE view that contains CANCELLED
 * invoices, and on 2026-08-12 production told the founder £4,525.00 was
 * outstanding when the only invoice on the book had been cancelled. Home, on
 * the same data, correctly said nothing was. `collectable` is that same filter
 * with the states nobody is collecting removed, and it is what every ordinary
 * heading gets; `matched` is now reserved for the headings that ASK for
 * uncollectable money and say so.
 */
export function bookMoneyPanel(
  book: {
    chasedByCurrency: CurrencyTotal[];
    matchedByCurrency: CurrencyTotal[];
    collectableByCurrency: CurrencyTotal[];
  },
  requestedCurrency?: string,
  view?: string,
): {
  currencies: CurrencyTotal[];
  selectedCurrency: string;
  money: CurrencyTotal | undefined;
} {
  const selectedCurrency = defaultBookCurrency(book.chasedByCurrency, requestedCurrency);
  const figures =
    view !== undefined && NON_COLLECTING_VIEWS.has(view)
      ? book.matchedByCurrency
      : book.collectableByCurrency;
  return {
    currencies: book.chasedByCurrency,
    selectedCurrency,
    money: figures.find((row) => row.currency === selectedCurrency),
  };
}

/**
 * What the money at the top of the book is COUNTING, in the reader's words.
 *
 * ⚠️ THE MONEY FOLLOWS THE FILTER, SO THE SENTENCE MUST NAME THE FILTER.
 * Before this existed the panel showed whole-book money above a table filtered
 * to Overdue: "£2,600.00 outstanding across 3 invoices" sat directly above
 * "1 invoice", and the two numbers appeared to disagree. Whichever figure a
 * reader trusted, one of them was answering a question they had not asked.
 *
 * ⚠️ EACH VIEW GETS ITS OWN WORD, AND "OUTSTANDING" IS NOT A SAFE DEFAULT.
 * A draft has not been sent to anybody, so no money in it is outstanding —
 * calling it that would misreport the one figure a business reads first, in
 * the direction that flatters us.
 *
 * ⚠️ THE UNFILTERED VIEW WAS ONCE ASSUMED TO BE THE SAFE ONE HERE. It is the
 * least safe of all: "Everything" is the only view that includes CANCELLED
 * invoices, and that assumption is what shipped a wrong number to production.
 * The wording is now only half the guard — `bookMoneyPanel` chooses which
 * money is counted and this chooses what to call it, and the two must agree.
 */
const TOTAL_LINE: Readonly<Record<string, { some: string; none: string }>> = {
  overdue: { some: "overdue across", none: "Nothing overdue in" },
  due_today: { some: "due today, across", none: "Nothing due today in" },
  due_soon: { some: "due soon, across", none: "Nothing due soon in" },
  draft: { some: "in drafts, across", none: "No drafts in" },
  /* Reachable by typing `?status=cancelled` — the filters live in the URL on
     purpose. With no words of its own it fell through to "outstanding", which
     is the precise sentence that overstated the founder's book. */
  cancelled: { some: "in cancelled invoices, across", none: "No cancelled invoices in" },
};

const TOTAL_LINE_DEFAULT = { some: "outstanding across", none: "Nothing outstanding in" };

/**
 * What is on screen, in the currency being shown.
 *
 * ⚠️ ONE CURRENCY AT A TIME, ALWAYS (trap 3b; founder's choice 2026-08-04).
 * A UK business with buyers in Singapore and the UAE holds GBP, SGD and AED in
 * one book, and adding them gives a confident wrong number. The picker beside
 * this line names the others so choosing GBP cannot hide the AED.
 *
 * An unknown `view` falls back to the plain wording rather than throwing: the
 * status comes off a URL anybody can edit, and a screen that 500s because a
 * query string was mistyped is worse than one that says "outstanding".
 */
export function bookTotalLine(input: {
  currency: string;
  formattedOutstanding: string;
  invoiceCount: number;
  view?: string | undefined;
}): string {
  const words = (input.view ? TOTAL_LINE[input.view] : undefined) ?? TOTAL_LINE_DEFAULT;
  if (input.invoiceCount === 0) {
    return `${words.none} ${input.currency}.`;
  }
  const invoices = input.invoiceCount === 1 ? "1 invoice" : `${input.invoiceCount} invoices`;
  return `${input.formattedOutstanding} ${words.some} ${invoices}.`;
}

/**
 * The line naming the currencies NOT currently being totalled.
 *
 * Exists so the founder's "filter to one currency" choice cannot hide money:
 * the total says GBP, and this says the AED and SGD are still there.
 */
export function otherCurrenciesLine(
  currencies: readonly { currency: string }[],
  selected: string,
): string | null {
  const others = currencies.map((row) => row.currency).filter((code) => code !== selected);
  if (others.length === 0) return null;
  if (others.length === 1) return `You are also owed money in ${others[0]}.`;
  const last = others[others.length - 1];
  return `You are also owed money in ${others.slice(0, -1).join(", ")} and ${last}.`;
}

/**
 * When this invoice was last chased and when it is next due to be.
 *
 * ⚠️ AN EMPTY `lastChasedOn` DOES NOT MEAN "NEVER CHASED", and saying so would
 * be a lie for as long as slice 1.7 does not exist: nothing sends yet, so no
 * reminder can ever have been sent. The honest report is what is SCHEDULED —
 * which is real today — and silence about sends that have not happened.
 */
export function chaseTimingLine(invoice: {
  isChased: boolean;
  lastChasedOn: string | null;
  nextChaseOn: string | null;
  formatDate: (value: string) => string;
}): string {
  if (invoice.lastChasedOn !== null) {
    const last = `Last chased ${invoice.formatDate(invoice.lastChasedOn)}`;
    return invoice.nextChaseOn !== null
      ? `${last} · next ${invoice.formatDate(invoice.nextChaseOn)}`
      : last;
  }
  if (invoice.nextChaseOn !== null) {
    return `Due to be chased ${invoice.formatDate(invoice.nextChaseOn)}`;
  }
  // Being chased with nothing queued is a real and worrying state — it is what
  // an invoice looks like when the schedule never got built.
  return invoice.isChased ? "No reminders scheduled" : "—";
}

/** The one-line description of what the table is currently showing. */
export function bookFilterLine(input: {
  totalCount: number;
  showing: number;
  status?: string | undefined;
  search?: string | undefined;
}): string {
  if (input.totalCount === 0) {
    if (input.search) return `No invoices match “${input.search}”.`;
    if (input.status) return "No invoices in that state.";
    return "No invoices yet. Add one, or upload a spreadsheet.";
  }
  const invoices = input.totalCount === 1 ? "1 invoice" : `${input.totalCount} invoices`;
  // Only mention paging when there IS paging — "showing 15 of 15" is noise.
  return input.showing < input.totalCount
    ? `Showing ${input.showing} of ${invoices}.`
    : `${invoices}.`;
}
