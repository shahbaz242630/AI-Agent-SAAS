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
 * Decimal major units as written in a file ("1234.56", "£1,234.56") →
 * integer minor units (123456). Returns null when the value is not a
 * positive amount with at most two decimal places.
 */
export function parseImportAmount(raw: string): number | null {
  const cleaned = raw.replace(/[£$\s]/g, "");
  // Plain digits, or digits with correctly-placed thousand separators.
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned) && !/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const minorUnits = Math.round(Number(cleaned.replace(/,/g, "")) * 100);
  return minorUnits > 0 ? minorUnits : null;
}

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
