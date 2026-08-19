import { minorUnitsToNumber, parseAmountToMinorUnits } from "@eva/types";

/**
 * Semantic value parsing (1.3 plan §3): raw strings (staged from a file, or
 * extracted from a PDF — Slice 1.4, promoted here from the imports module)
 * are converted to the canonical invoice values. Amounts become integer minor
 * units (money is never float — BRD 10); dates accept ISO (YYYY-MM-DD) and
 * UK (DD/MM/YYYY) forms; currency defaults to GBP. Pure functions so upload
 * staging, extraction and confirm parse identically (plan §3: "validated
 * against rules shared with createInvoiceRequestSchema").
 */

/**
 * Decimal major units as written in a file ("1234.56", "£1,234.56") → integer
 * minor units, FOR THIS CURRENCY. Null when it is not a positive amount.
 *
 * ⚠️ `currency` is required, and that is the whole point (slice 1.6c). This
 * function used to cap decimals at two and multiply by 100, which is right for
 * GBP/AED/USD and wrong for both other ISO 4217 groups: a Kuwaiti invoice for
 * 12.345 KWD was rejected outright, and a Japanese ¥1000 became 100000. GCC is
 * the next market and three of its six currencies carry three decimals.
 *
 * The arithmetic lives in `@eva/types` because the web app has to agree with
 * this exactly — two copies of a minor-unit table become two different answers
 * for the same invoice.
 */
export function parseImportAmount(raw: string, currency: string): number | null {
  const minorUnits = parseAmountToMinorUnits(raw, currency);
  if (minorUnits === null || minorUnits <= 0n) return null;
  return minorUnitsToNumber(minorUnits);
}

/**
 * The widest precision ISO 4217 defines, used ONLY to rank candidate amounts
 * scraped from a PDF before the currency is known.
 *
 * Ranking needs every candidate to survive parsing and to be scaled the same
 * way — it compares them and returns the winning RAW STRING, so the scale
 * itself never leaves this step. Parsing candidates at two decimals instead
 * would silently drop every three-decimal amount from consideration, which is
 * the same GCC bug one layer further out.
 */
export const RANKING_PRECISION_CURRENCY = "BHD";

/** ISO (YYYY-MM-DD) or UK (DD/MM/YYYY) → a UTC-midnight Date; null if invalid. */
export function parseImportDate(raw: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (uk) {
    year = Number(uk[3]);
    month = Number(uk[2]);
    day = Number(uk[1]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}

/** Defaults GBP; normalises case; must be a 3-letter ISO 4217 code. */
export function normaliseImportCurrency(raw: string | undefined): string | null {
  if (raw === undefined) return "GBP";
  const upper = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}
