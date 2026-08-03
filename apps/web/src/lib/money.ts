import {
  formatMinorUnits,
  minorUnitDigits,
  minorUnitsToNumber,
  parseAmountToMinorUnits,
} from "@eva/types";

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
 * What a human typed in the amount box → what the API wants, or WHY not.
 *
 * ⚠️ THE VALUE COMES FROM `@eva/types` AND NOWHERE ELSE. This function never
 * does arithmetic on the input: `parseAmountToMinorUnits` is the single
 * implementation, it works on strings digit by digit, and it refuses anything
 * it cannot read exactly. Everything below is about the MESSAGE.
 *
 * The message matters more than it looks. `parseAmountToMinorUnits` answers
 * `null` for every kind of bad input, and "That isn't a valid amount" in front
 * of `12.345` typed into a GBP invoice tells the customer nothing — the amount
 * looks perfectly valid to them, and it IS valid, in Kuwait. So each refusal is
 * diagnosed afterwards and named.
 */
export type AmountParseResult = { ok: true; minorUnits: number } | { ok: false; message: string };

/** The longest input the shared parser will look at before refusing outright. */
const MAX_AMOUNT_INPUT_LENGTH = 64;

export function parseAmountInput(raw: string, currency: string): AmountParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, message: "Enter an amount." };

  const parsed = parseAmountToMinorUnits(trimmed, currency);

  if (parsed !== null) {
    let value: number;
    try {
      value = minorUnitsToNumber(parsed);
    } catch {
      // Beyond JavaScript's exact integer range. Unreachable through a form
      // anyone would fill in, but losing precision silently on money is the one
      // outcome not worth risking.
      return { ok: false, message: "That amount is too large to record." };
    }
    /**
     * ⚠️ ZERO PARSES FINE AND IS STILL NOT AN INVOICE. `"0"` and `"0.00"` are
     * perfectly good parses — but the API requires a positive amount and the
     * database has `invoices_amount_positive_chk`, so without this the customer
     * would get a raw 400 from a field that looked accepted.
     *
     * Checked on the NUMBER rather than against a `0n` literal: this app targets
     * ES2017, where a BigInt literal is a compile error. The tests pass either
     * way because Vitest transpiles differently — only `tsc` catches it.
     */
    if (value === 0) return { ok: false, message: "An invoice has to be for more than zero." };
    return { ok: true, minorUnits: value };
  }

  // --- Refused. Work out what to say. ---

  if (trimmed.length > MAX_AMOUNT_INPUT_LENGTH) {
    return { ok: false, message: "That doesn't look like an amount." };
  }

  // A minus sign, a Unicode minus, or accounting parentheses. Spelled as
  // escapes because a literal U+2212 in a character class is invisible to
  // review — both were written by accident on 2026-08-03.
  if (/[-−()]/.test(trimmed)) {
    return { ok: false, message: "An invoice amount has to be positive." };
  }

  const digits = minorUnitDigits(currency);
  const decimalPart = /\.(\d+)\s*[^\d.,]*$/.exec(trimmed);
  if (decimalPart && decimalPart[1] && decimalPart[1].length > digits) {
    return {
      ok: false,
      message:
        digits === 0
          ? `${currency.toUpperCase()} amounts don't have decimal places — enter a whole number.`
          : `${currency.toUpperCase()} amounts have at most ${String(digits)} decimal places.`,
    };
  }

  if (trimmed.includes(",")) {
    // A comma is a decimal separator in half the world and a thousands
    // separator in the other half, so the parser refuses rather than guessing —
    // guessing "1,5" wrong overstates a debt tenfold.
    return {
      ok: false,
      message: "Use a full stop for decimals — write thousands as 1,234.56.",
    };
  }

  return { ok: false, message: "That doesn't look like an amount." };
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
