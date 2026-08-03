import { formatMinorUnits, minorUnitDigits } from "@eva/types";

/**
 * Money, as a human reads it (slice 1.6c).
 *
 * ⚠️ THE ARITHMETIC IS NOT HERE, AND MUST NEVER BE. `@eva/types` owns the
 * minor-unit table, the parsing and the balance; this file only decides how to
 * present a value it has already been given. Two copies of a minor-unit table
 * become two different answers for one invoice, which is the whole reason that
 * package exists.
 *
 * ⚠️ `* 100` AND `/ 100` ARE DEFECTS. The number of digits in a minor unit
 * belongs to the CURRENCY: 0 for JPY/KRW/VND, 2 for GBP/AED/USD, 3 for
 * KWD/BHD/OMR. A Kuwaiti amount shown to two decimals is wrong by a factor of
 * ten, and GCC is the next market.
 */

/**
 * `12345` KWD → `"KWD 12.345"`, `450000` JPY → `"JPY 450,000"`.
 *
 * HOW THE VALUE REACHES `Intl`, and why it is done this way. The exact decimal
 * string comes from `formatMinorUnits`, which does integer arithmetic on a
 * bigint and cannot lose a digit. Only then is it handed to `Intl` for grouping
 * and the currency marker. The obvious alternative — dividing the minor units
 * by 100 — is the exact assumption slice 1.6c exists to delete.
 *
 * The fraction digits are pinned from OUR table rather than left to `Intl`'s
 * own currency data, so a currency `Intl` has never heard of still gets the
 * digits we stored it with instead of a silent default of two.
 */
export function formatMoney(minorUnits: number, currency: string, locale = "en-GB"): string {
  const digits = minorUnitDigits(currency);
  const exact = formatMinorUnits(BigInt(minorUnits), currency);

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number(exact));
  } catch {
    /**
     * `Intl` throws on a currency code that is not three letters. The API
     * validates ISO 4217 shape on write, so this should be unreachable — but an
     * invoice that cannot be displayed is worse than one displayed plainly, and
     * a screen that throws takes the whole list with it.
     */
    return `${currency} ${exact}`;
  }
}

/**
 * A due date, written the way a person reads one.
 *
 * ⚠️ TAKES THE DATE THE API SENT AND DOES NOT REASON ABOUT "TODAY". Whether an
 * invoice is overdue is decided by the API from the ORGANISATION's timezone and
 * arrives as `displayStatus`; asking the browser would mean an invoice changes
 * status when the customer travels (trap 1). This formats a calendar date and
 * nothing more.
 *
 * `timeZone: "UTC"` is deliberate and load-bearing: `due_date` is a DATE column
 * that arrives as midnight UTC, so formatting it in the browser's local zone
 * shows the PREVIOUS day for anyone west of UTC. A due date that reads as a day
 * early on half the world's screens is the kind of defect that looks like a
 * data problem for weeks.
 */
export function formatDueDate(value: string | Date, locale = "en-GB"): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
