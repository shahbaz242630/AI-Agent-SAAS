import type { ReminderActivityDto, ReminderWaitingReason } from "@eva/types";

/**
 * What the home screen says (Slice 1.9).
 *
 * Replaces an "account" page that showed a name, an email and a list of role
 * keys — everything except the one thing the business cares about, which is how
 * much money is outstanding.
 *
 * ⚠️ THIS FILE MUST NEVER ADD TWO CURRENCIES TOGETHER, AND THE SHAPE IS THE
 * GUARD. Every total is returned PER CURRENCY, because minor units are not
 * comparable across them: 4,750.499 KWD is 4,750,499 fils and £1,500.00 is
 * 150,000 pence, so "biggest number wins" opens a mostly-sterling book on its
 * three Kuwaiti invoices. That exact defect shipped once (`invoice-book.ts`),
 * and a dashboard is the most tempting possible place to repeat it — a single
 * big "you are owed" figure is what everyone expects to see, and it would be a
 * confident lie for any business trading in more than one currency.
 */

/** One currency's slice of the book, as the API already returns it. */
export interface CurrencyTotal {
  currency: string;
  invoiceCount: number;
  outstandingMinorUnits: number;
}

/**
 * The per-currency rows, in a stable order.
 *
 * ⚠️ ORDERED BY INVOICE COUNT, NEVER BY AMOUNT — a COUNT has no units, so it is
 * the only figure that can honestly be compared between currencies. Ties break
 * alphabetically so the screen does not reshuffle between page loads.
 */
export function owedRows(chased: readonly CurrencyTotal[]): CurrencyTotal[] {
  return [...chased]
    .filter((row) => row.invoiceCount > 0)
    .sort((a, b) => b.invoiceCount - a.invoiceCount || a.currency.localeCompare(b.currency));
}

/**
 * The line above the figures.
 *
 * ⚠️ AN EMPTY BOOK IS THE HEALTHIEST STATE THERE IS AND MUST NOT READ AS AN
 * ERROR. A new customer, or one whose clients all pay on time, should be told
 * that plainly rather than shown a blank panel that looks like a failure to
 * load — the same rule the chase activity screen follows for "nothing yet".
 */
export function owedHeadline(rows: readonly CurrencyTotal[]): string {
  if (rows.length === 0) return "Nothing outstanding — every invoice on your book is settled.";
  if (rows.length === 1) {
    const only = rows[0]!;
    return only.invoiceCount === 1
      ? "1 invoice is outstanding."
      : `${only.invoiceCount} invoices are outstanding.`;
  }
  const invoices = rows.reduce((sum, row) => sum + row.invoiceCount, 0);
  // Counts add up across currencies; money does not. Naming the number of
  // currencies is what stops a reader mentally totalling the figures below.
  return `${invoices} invoices are outstanding, in ${rows.length} currencies.`;
}

/** Something the customer has to do, or Eva stays stuck. */
export interface AttentionItem {
  kind: "no_mailbox" | "reminders_failed" | "reminders_waiting";
  headline: string;
  detail: string;
  href: string | null;
  linkLabel: string | null;
}

/**
 * What needs a human, hardest-blocking first.
 *
 * ⚠️ ORDER IS THE MESSAGE. A disconnected mailbox is upstream of everything —
 * fixing it fixes the waiting reminders too — so putting "12 reminders waiting"
 * above it would send someone to investigate a symptom. Nothing is invented when
 * the answer is "all fine": an empty list means the panel is not rendered at
 * all, which is the honest way to say there is nothing to do.
 */
export function attentionItems(input: {
  mailboxConnected: boolean | null;
  counts: ReminderActivityDto["counts"];
  waitingReason: ReminderWaitingReason | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  // `null` means we could not tell (no permission, or no Invoice Chasing) —
  // fail QUIET rather than telling someone to fix a mailbox that may be fine.
  if (input.mailboxConnected === false) {
    items.push({
      kind: "no_mailbox",
      headline: "No mailbox is connected",
      detail:
        "Eva has nowhere to send from, so nothing will go out. Nothing is lost — connect a mailbox and anything waiting sends on the next run.",
      href: "/app/settings/mailbox",
      linkLabel: "Connect a mailbox",
    });
  }

  if (input.counts.failedLast7Days > 0) {
    const n = input.counts.failedLast7Days;
    items.push({
      kind: "reminders_failed",
      headline: n === 1 ? "1 reminder didn't send" : `${n} reminders didn't send`,
      detail:
        "Eva could not deliver these and will not retry them automatically. Worth a look at what went wrong.",
      href: "/app/reminders",
      linkLabel: "See what happened",
    });
  }

  /**
   * Only when a mailbox is not already named as the cause. Saying "3 waiting"
   * underneath "no mailbox is connected" is the same fact twice, and the second
   * telling makes the first look like a different problem.
   */
  if (input.counts.waiting > 0 && input.waitingReason !== "no_working_mailbox") {
    const n = input.counts.waiting;
    items.push({
      kind: "reminders_waiting",
      headline: n === 1 ? "1 reminder is waiting" : `${n} reminders are waiting`,
      detail:
        "These are due and have not gone out yet. Nothing is lost — Eva tries again on the next run.",
      href: "/app/reminders",
      linkLabel: "See what is waiting",
    });
  }

  return items;
}

/**
 * The one line summarising Eva's week, shown whether or not she did anything.
 *
 * "Eva hasn't needed to chase anyone" is a real and good answer — a customer
 * whose clients all pay on time should not see a screen that implies something
 * is broken.
 */
export function chaseSummary(counts: ReminderActivityDto["counts"]): string {
  if (counts.sentLast7Days === 0 && counts.waiting === 0 && counts.failedLast7Days === 0) {
    return "Eva hasn't needed to chase anyone this week.";
  }
  const sent =
    counts.sentLast7Days === 1 ? "1 reminder sent" : `${counts.sentLast7Days} reminders sent`;
  return `${sent} in the last 7 days.`;
}
