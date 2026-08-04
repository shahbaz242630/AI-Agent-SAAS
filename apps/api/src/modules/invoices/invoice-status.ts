import { isChasedInvoiceStatus } from "@eva/types";
import type { InvoiceDisplayStatus, InvoiceStoredStatus } from "@eva/types";

/**
 * Time-derived invoice statuses (Slice 1.2 plan §7.1): due_soon / due_today /
 * overdue are NEVER stored — they are derived at read time from due_date plus
 * the organisation timezone (organisation_settings.timezone, default
 * Europe/London; BRD 18.1). Pure functions, Node Intl only (no packages).
 * The 1.5 scheduler will read this same derivation.
 */

const DAY_MS = 86_400_000;

/** UTC millisecond key of the calendar day `instant` falls on in `timezone`. */
function calendarDayKey(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  return Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
}

/**
 * The display status for an invoice: the stored status, unless Eva is CHASING
 * it — then due_date relative to TODAY IN THE ORG TIMEZONE decides:
 * past → overdue, today → due_today, within 3 days → due_soon (the first
 * BRD 4.1 reminder stage), otherwise the stored status. Derivation never
 * applies to unchased invoices, so Paid/Disputed/Paused/Cancelled can never
 * receive reminders by accident (plan §7.1).
 *
 * ⚠️ `partially_paid` DERIVES TOO, and it must (slice 1.6c). This tested
 * `!== "active"`, so a part-paid invoice forty days late would have shown
 * "Part paid" and could never have shown "Overdue" — dropping it out of every
 * overdue view in the product, which is precisely where a debtor who paid a
 * token amount and went quiet needs to appear. How much has been paid is not
 * lost by this: it is on the row, beside the balance.
 *
 * The fall-through returns the STORED status rather than "active" so a
 * part-paid invoice that is not yet due still reads "Part paid".
 */
export function deriveDisplayStatus(
  invoice: { status: string; dueDate: Date },
  timezone: string,
  now: Date = new Date(),
): InvoiceDisplayStatus {
  if (!isChasedInvoiceStatus(invoice.status)) return invoice.status as InvoiceStoredStatus;
  // due_date is a DATE column (UTC midnight); compare calendar days, never
  // server-local time — all business logic runs in the org timezone.
  const diffDays = Math.round(
    (calendarDayKey(invoice.dueDate, "UTC") - calendarDayKey(now, timezone)) / DAY_MS,
  );
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "due_today";
  if (diffDays <= 3) return "due_soon";
  return invoice.status;
}

/** The calendar day `now` falls on in `timezone`, as a UTC-midnight Date. */
export function todayInTimezone(timezone: string, now: Date = new Date()): Date {
  return new Date(calendarDayKey(now, timezone));
}
