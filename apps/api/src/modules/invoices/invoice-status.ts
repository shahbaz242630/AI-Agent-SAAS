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
 * The display status for an invoice: the stored status, unless the invoice is
 * Active — then due_date relative to TODAY IN THE ORG TIMEZONE decides:
 * past → overdue, today → due_today, within 3 days → due_soon (the first
 * BRD 4.1 reminder stage), otherwise active. Derivation never applies to
 * non-Active invoices, so Paid/Disputed/Paused/Cancelled can never receive
 * reminders by accident (plan §7.1).
 */
export function deriveDisplayStatus(
  invoice: { status: string; dueDate: Date },
  timezone: string,
  now: Date = new Date(),
): InvoiceDisplayStatus {
  if (invoice.status !== "active") return invoice.status as InvoiceStoredStatus;
  // due_date is a DATE column (UTC midnight); compare calendar days, never
  // server-local time — all business logic runs in the org timezone.
  const diffDays = Math.round(
    (calendarDayKey(invoice.dueDate, "UTC") - calendarDayKey(now, timezone)) / DAY_MS,
  );
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "due_today";
  if (diffDays <= 3) return "due_soon";
  return "active";
}

/** The calendar day `now` falls on in `timezone`, as a UTC-midnight Date. */
export function todayInTimezone(timezone: string, now: Date = new Date()): Date {
  return new Date(calendarDayKey(now, timezone));
}
