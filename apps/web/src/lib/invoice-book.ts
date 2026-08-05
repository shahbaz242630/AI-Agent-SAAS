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

/**
 * What the organisation is owed, in the currency being shown.
 *
 * ⚠️ ONE CURRENCY AT A TIME, ALWAYS (trap 3b; founder's choice 2026-08-04).
 * A UK business with buyers in Singapore and the UAE holds GBP, SGD and AED in
 * one book, and adding them gives a confident wrong number. The picker beside
 * this line names the others so choosing GBP cannot hide the AED.
 */
export function bookTotalLine(input: {
  currency: string;
  formattedOutstanding: string;
  invoiceCount: number;
}): string {
  if (input.invoiceCount === 0) {
    return `Nothing outstanding in ${input.currency}.`;
  }
  const invoices = input.invoiceCount === 1 ? "1 invoice" : `${input.invoiceCount} invoices`;
  return `${input.formattedOutstanding} outstanding across ${invoices}.`;
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
