import type { InvoiceDisplayStatus } from "@eva/types";

/**
 * What an invoice status means to a human (slice 1.6c, task 2).
 *
 * A pure module in `lib` rather than helpers inside the page, following the
 * `mailbox-messages.ts` precedent: copy is what this project keeps shipping
 * broken through a fully green gate — "lowering to 1 seats" and "If you arethe
 * administrator" both reached staging — and here it is testable without
 * rendering anything.
 *
 * ⚠️ THIS MODULE NEVER DECIDES WHAT AN INVOICE'S STATUS *IS*. It only says how
 * to write one down. `due_soon` / `due_today` / `overdue` are derived per
 * request by the API from the due date and the ORGANISATION's timezone
 * (`invoice-status.ts` in the api). Deriving them here from the browser's clock
 * would make an invoice change status when the user travels — a debtor in Dubai
 * and a server in Frankfurt disagree about what day it is (trap 1).
 */

/**
 * Every status a human might see: the nine STORED ones plus the three the API
 * derives for Active invoices.
 *
 * ⚠️ `Record<InvoiceDisplayStatus, …>` IS THE EXHAUSTIVENESS GUARANTEE. Adding
 * a status to `@eva/types` without giving it a label fails the build, so there
 * is no rule for anyone to remember. A `switch` with a `default` would silently
 * absorb the new status and print something wrong instead — the same reasoning
 * `PERMISSION_MODULE` uses in `@eva/types`.
 */
const STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  /**
   * ⚠️ NOT "Closed", "Done", "Settled" or anything else that could be mistaken
   * for payment (trap 7). A cancelled invoice was abandoned; a paid one was
   * paid. The two must never be confusable, because the whole point of
   * recording a payment is that "we stopped chasing" and "they paid us" are
   * different facts — and until this slice, cancelling was the only way to stop
   * a chase, so the trail already says `cancelled` in places where somebody
   * actually paid.
   */
  cancelled: "Cancelled",
  promise_to_pay: "Promised to pay",
  disputed: "Disputed",
  /** "Part paid", not "Partially paid" — shorter, and it fits a table cell. */
  partially_paid: "Part paid",
  paid: "Paid",
  written_off: "Written off",
  due_soon: "Due soon",
  due_today: "Due today",
  overdue: "Overdue",
};

/**
 * How much attention a status deserves. Lives here rather than in the page so
 * that the meaning of a status is decided in exactly one place — a second
 * mapping inside a component drifts from this one the first time either
 * changes.
 */
export type InvoiceStatusTone = "neutral" | "positive" | "attention" | "urgent" | "muted";

const STATUS_TONES: Record<InvoiceDisplayStatus, InvoiceStatusTone> = {
  draft: "muted",
  active: "neutral",
  due_soon: "attention",
  due_today: "attention",
  overdue: "urgent",
  paused: "muted",
  // Muted, never positive — see the label note above. Only `paid` is positive.
  cancelled: "muted",
  promise_to_pay: "attention",
  disputed: "urgent",
  // Still owed, so it is not a resting state: there is a balance to chase.
  partially_paid: "attention",
  paid: "positive",
  written_off: "muted",
};

function isKnownStatus(status: string): status is InvoiceDisplayStatus {
  return Object.hasOwn(STATUS_LABELS, status);
}

/**
 * The human label for a status the API returned.
 *
 * Takes a plain `string` because that is what crosses the wire, and the web app
 * cannot assume it is never older than the API it is talking to — during a
 * deploy it demonstrably is. An unknown status is written out readably rather
 * than crashing the page or, worse, being quietly mapped onto a status we do
 * recognise.
 */
export function invoiceStatusLabel(status: string): string {
  if (isKnownStatus(status)) return STATUS_LABELS[status];
  // "some_new_state" → "Some new state". Says what the server said, claims
  // nothing extra, and cannot accidentally imply payment.
  const spaced = status.replace(/_/g, " ").trim();
  if (spaced === "") return "Unknown";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * How to style a status. An unknown one is `neutral`: it must not be dressed up
 * as good news or as an alarm when we do not know which it is.
 */
export function invoiceStatusTone(status: string): InvoiceStatusTone {
  return isKnownStatus(status) ? STATUS_TONES[status] : "neutral";
}

/**
 * Can this invoice still be edited?
 *
 * `PATCH` is DRAFT-ONLY in the API. Offering an edit form on anything else
 * produces a 400 the customer can do nothing about (trap 4), so the screen must
 * not offer it — and must say why rather than simply hiding the control, which
 * reads as a missing feature.
 */
export function isInvoiceEditable(status: string): boolean {
  return status === "draft";
}

/**
 * Why editing is unavailable, or null when it is available.
 *
 * Phrased per outcome rather than as one generic sentence, because "this
 * invoice has been issued" is untrue of a cancelled one and unhelpful next to a
 * paid one.
 */
export function invoiceEditBlockedReason(status: string): string | null {
  if (isInvoiceEditable(status)) return null;
  if (status === "cancelled") return "This invoice was cancelled, so it can no longer be edited.";
  if (status === "paid" || status === "written_off") {
    return `This invoice is ${invoiceStatusLabel(status).toLowerCase()}, so it can no longer be edited.`;
  }
  // Everything else has been issued to the debtor: active, paused, part paid,
  // disputed, promised, and the three derived states. Changing an invoice
  // somebody has already received is how the numbers stop matching theirs.
  return "Only a draft can be edited — this invoice has already been issued.";
}
