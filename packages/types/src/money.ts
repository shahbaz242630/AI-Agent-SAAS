/**
 * Money: minor units, per currency (Slice 1.6c).
 *
 * ⚠️ THE ASSUMPTION THIS FILE EXISTS TO DELETE: "minor units = major × 100".
 *
 * ISO 4217 defines three groups, and the founder's own launch list spans all
 * three:
 *
 *   0 digits — JPY, KRW, VND, IDR …  (Asia)
 *   2 digits — GBP, USD, EUR, AED, SAR, QAR
 *   3 digits — KWD, BHD, OMR, JOD, TND …  (GCC — three of the six GCC states)
 *
 * Before this file, `parseImportAmount` accepted at most two decimal places and
 * multiplied by 100. A Kuwaiti invoice for 12.345 KWD was REJECTED outright, and
 * had it been accepted the third digit would have been silently dropped. GCC is
 * the next market.
 *
 * Everything that converts between what a human types and what the database
 * stores must go through here. `* 100` and `/ 100` are defects.
 */

/** ISO 4217 currencies whose minor unit is NOT the usual two digits. */
const MINOR_UNIT_DIGITS: Readonly<Record<string, 0 | 3>> = {
  // --- 0 digits: the "major unit IS the minor unit" currencies ---
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // --- 3 digits: mostly Gulf and North Africa. The reason this file exists. ---
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/**
 * How many digits this currency's minor unit has.
 *
 * Unknown codes get 2 — the overwhelming majority, and the safe default for a
 * currency we have not met. Deliberately NOT an error: refusing to store an
 * invoice because we do not recognise its currency would be worse than assuming
 * the common case, and the ISO 4217 shape check already happened in validation.
 */
export function minorUnitDigits(currency: string): 0 | 2 | 3 {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2;
}

/** 10^digits, as a bigint — the multiplier between major and minor units. */
function scale(currency: string): bigint {
  return 10n ** BigInt(minorUnitDigits(currency));
}

/**
 * Whitespace only — ASCII space and U+00A0 NON-BREAKING SPACE, which is what
 * Excel and most European locales emit as a thousands separator.
 *
 * ⚠️ THE COMMA IS DELIBERATELY NOT HERE. It used to be, and that quietly
 * defeated the ambiguity check below: "1,5" had its comma stripped before
 * anything could ask what the comma MEANT, and came back as 150 minor units
 * instead of 15. Whitespace is never a decimal separator; a comma is, half the
 * world over.
 *
 * The NBSP is spelled as an escape on purpose — a literal one in a character
 * class survives review precisely because nobody can see it.
 */
const WHITESPACE = /[\s\u00A0]/g;

/**
 * What a human typed → integer minor units. Returns null when the input is not
 * a valid amount FOR THIS CURRENCY.
 *
 * Accepts a currency symbol or code on either side, thousands separators, and
 * up to exactly as many decimal places as the currency has — `12.345` is valid
 * KWD and invalid GBP; `1000` is valid JPY and `1000.5` is not.
 *
 * ⚠️ Parsed as a STRING, digit by digit — never `Number(x) * 100`. Floating
 * point cannot represent 1.005, and the classic `Math.round(1.005 * 100)` gives
 * 100 rather than 101. There is no float anywhere in this function.
 */
export function parseAmountToMinorUnits(raw: string, currency: string): bigint | null {
  /**
   * ⚠️ NEGATIVES ARE REJECTED, NOT STRIPPED — checked BEFORE any cleaning.
   *
   * The symbol strip below removes whatever sits either side of the digits so
   * that "£1,234.56" and "1234.56 AED" both work. A minus sign is not a symbol,
   * and an earlier draft of this function quietly ate it: `-5.00` parsed to
   * `500n`, turning a credit into a debt Eva would then chase. Accounting
   * parentheses — `(1,234.56)` — are the same trap wearing a different hat.
   *
   * Both are refused. `invoices_amount_positive_chk` requires > 0 anyway, so
   * there is no legitimate negative to preserve; the only question was whether
   * we say no or silently change the sign.
   */
  if (/[-\u2212()]/.test(raw)) return null;
  // Spaces (including NBSP) are never a decimal separator, so they go
  // unconditionally, along with any symbol or code on either side — "£1,234.56",
  // "1 234 567", "1234.56 AED" and "¥1000" all reach one place.
  const stripped = raw
    .replace(WHITESPACE, "")
    .replace(/^[^\d.,]+/, "")
    .replace(/[^\d.,]+$/, "");

  /**
   * ⚠️ A COMMA IS NOT ALWAYS A THOUSANDS SEPARATOR, and guessing costs 10x.
   *
   * Half the world writes 1,50 for one and a half. Stripping commas
   * unconditionally turns that into 150 minor units where it should be 15 — a
   * tenfold overstatement of a debt, produced confidently and silently.
   *
   * A comma therefore counts as grouping ONLY where it is followed by exactly
   * three digits. Anything else — "1,5", "1.234,56", Indian lakh grouping like
   * "12,34,567" — is REFUSED rather than interpreted. A refusal is visible and
   * someone fixes the file; a wrong number is invisible and someone gets chased
   * for it. (Indian grouping is a deliberate documented refusal, not an
   * oversight: it can be added when a customer needs it, with its own tests.)
   */
  let cleaned = stripped;
  if (cleaned.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return null;
    cleaned = cleaned.replace(/,/g, "");
  }
  const digits = minorUnitDigits(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;

  const whole = match[1]!;
  const fraction = match[2] ?? "";
  // MORE precision than the currency has is a mistake, not something to round
  // away silently: 12.345 GBP is not 12.35, it is a typo or the wrong currency.
  if (fraction.length > digits) return null;

  const padded = fraction.padEnd(digits, "0");
  return BigInt(whole) * scale(currency) + (padded === "" ? 0n : BigInt(padded));
}

/**
 * Integer minor units → a plain decimal string with the right number of decimal
 * places for the currency. No symbol, no grouping — presentation is the
 * caller's business; this is the value.
 */
export function formatMinorUnits(minorUnits: bigint, currency: string): string {
  const digits = minorUnitDigits(currency);
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const factor = scale(currency);
  const sign = negative ? "-" : "";
  const whole = absolute / factor;
  if (digits === 0) return `${sign}${whole.toString()}`;
  const fraction = (absolute % factor).toString().padStart(digits, "0");
  return `${sign}${whole.toString()}.${fraction}`;
}

/**
 * What Eva actually chases: what is LEFT, never the total.
 *
 * Clamped at zero because overpayment is ALLOWED (founder ruling 2026-08-02 —
 * we are not accountants). A negative balance would read as a debt owed the
 * other way and would have Eva chasing a credit.
 */
export function outstandingBalance(amountMinorUnits: bigint, amountPaidMinorUnits: bigint): bigint {
  const balance = amountMinorUnits - amountPaidMinorUnits;
  return balance > 0n ? balance : 0n;
}

/**
 * The database columns are BIGINT (migration 0021) so a Vietnamese or
 * Indonesian invoice fits; JSON has no bigint, so responses carry a number.
 *
 * That is safe — JavaScript integers are exact to 9,007,199,254,740,991, which
 * is ₫9 quadrillion — but "safe" is worth enforcing rather than assuming.
 * Anything beyond it is a bug upstream, and silently losing precision on money
 * is the one outcome not worth risking.
 */
export function minorUnitsToNumber(minorUnits: bigint): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (minorUnits > limit || minorUnits < -limit) {
    throw new RangeError(
      `Money value ${minorUnits.toString()} exceeds the safe integer range and cannot be sent as JSON`,
    );
  }
  return Number(minorUnits);
}
