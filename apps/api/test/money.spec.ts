import { describe, expect, it } from "vitest";
import {
  formatMinorUnits,
  minorUnitDigits,
  minorUnitsToNumber,
  outstandingBalance,
  parseAmountToMinorUnits,
} from "@eva/types";

/**
 * Money conversion across the three ISO 4217 exponent groups (Slice 1.6c).
 *
 * ⚠️ A test written only in GBP CANNOT FAIL on the bug this module exists to
 * prevent. The old `parseImportAmount` hard-coded ×100 and capped decimals at
 * two, which is correct for GBP/AED/USD and wrong for every currency in the
 * founder's stated launch list: KWD/BHD/OMR have THREE decimals (GCC) and
 * JPY/KRW/VND have NONE (Asia). Every case below therefore names its currency
 * deliberately.
 *
 * Lives in the api suite because no package under `packages/` has test infra,
 * and because the api resolves `@eva/types` to its BUILT output — so these
 * exercise the artifact that ships, not the source.
 */

describe("minorUnitDigits", () => {
  it("knows the three groups", () => {
    expect(minorUnitDigits("KWD")).toBe(3);
    expect(minorUnitDigits("BHD")).toBe(3);
    expect(minorUnitDigits("OMR")).toBe(3);
    expect(minorUnitDigits("GBP")).toBe(2);
    expect(minorUnitDigits("AED")).toBe(2);
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("VND")).toBe(0);
  });

  it("is case-insensitive and defaults an unknown code to 2 rather than failing", () => {
    expect(minorUnitDigits("kwd")).toBe(3);
    // Refusing to store an invoice because we have not met its currency would
    // be worse than assuming the common case.
    expect(minorUnitDigits("ZZZ")).toBe(2);
  });
});

describe("parseAmountToMinorUnits", () => {
  it("uses the currency's own exponent, not a constant 100", () => {
    // THE GCC CASE. The previous implementation rejected this outright.
    expect(parseAmountToMinorUnits("12.345", "KWD")).toBe(12345n);
    expect(parseAmountToMinorUnits("12.34", "GBP")).toBe(1234n);
    // THE ASIA CASE. ¥1000 is 1000 minor units, not 100000.
    expect(parseAmountToMinorUnits("1000", "JPY")).toBe(1000n);
  });

  it("rejects more precision than the currency has, rather than rounding it away", () => {
    // 12.345 GBP is not 12.35 — it is a typo, or the wrong currency.
    expect(parseAmountToMinorUnits("12.345", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("1000.5", "JPY")).toBeNull();
    expect(parseAmountToMinorUnits("12.3456", "KWD")).toBeNull();
  });

  it("pads a short fraction to the currency's width", () => {
    expect(parseAmountToMinorUnits("12.3", "GBP")).toBe(1230n);
    expect(parseAmountToMinorUnits("12.3", "KWD")).toBe(12300n);
    expect(parseAmountToMinorUnits("12", "GBP")).toBe(1200n);
    expect(parseAmountToMinorUnits("12", "KWD")).toBe(12000n);
  });

  /**
   * The reason this is string arithmetic. `Math.round(1.005 * 100)` is 100, not
   * 101, because 1.005 is not representable in binary floating point. There is
   * no float in the implementation, so these are exact.
   */
  it("is exact where floating point is not", () => {
    expect(parseAmountToMinorUnits("1.005", "KWD")).toBe(1005n);
    expect(parseAmountToMinorUnits("0.1", "GBP")).toBe(10n);
    expect(parseAmountToMinorUnits("0.29", "GBP")).toBe(29n);
    expect(parseAmountToMinorUnits("8.165", "KWD")).toBe(8165n);
  });

  it("accepts the separators and symbols real input carries", () => {
    expect(parseAmountToMinorUnits("1,234.56", "GBP")).toBe(123456n);
    expect(parseAmountToMinorUnits("£1,234.56", "GBP")).toBe(123456n);
    expect(parseAmountToMinorUnits("1234.56 AED", "AED")).toBe(123456n);
    expect(parseAmountToMinorUnits("¥1000", "JPY")).toBe(1000n);
    // U+00A0 — what Excel and most European locales emit as a group separator.
    // Built from an escape on purpose: typed as a literal it is invisible here,
    // and an ordinary space would pass, so the case would prove nothing.
    const nbsp = "\u00A0";
    expect(parseAmountToMinorUnits(`1${nbsp}234${nbsp}567`, "VND")).toBe(1234567n);
  });

  it("returns null for things that are not amounts", () => {
    expect(parseAmountToMinorUnits("", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("abc", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("1.2.3", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("-5.00", "GBP")).toBeNull();
    // A minus is not a currency symbol. An earlier draft stripped it with the
    // £ and $ and returned 500n — a credit silently became a debt to chase.
    expect(parseAmountToMinorUnits("−5.00", "GBP")).toBeNull();
    // The same trap in accounting dress.
    expect(parseAmountToMinorUnits("(1,234.56)", "GBP")).toBeNull();
    // European decimal-comma form. Rejected rather than silently read as
    // 1.23456 — a confident wrong number is worse than a refusal.
    expect(parseAmountToMinorUnits("1.234,56", "GBP")).toBeNull();
  });

  /**
   * A comma is a decimal separator in half the world. Stripping it blindly
   * turns "1,5" into 150 minor units where it should be 15 — a tenfold
   * overstatement of a debt, silently. Grouping is therefore only believed when
   * the comma is followed by exactly three digits.
   */
  it("refuses an ambiguous comma rather than guessing which side of the world wrote it", () => {
    expect(parseAmountToMinorUnits("1,5", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("1,50", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("1,23.4", "GBP")).toBeNull();
    // Indian lakh grouping — a documented refusal, not an oversight. Safe: a
    // refusal is visible, a wrong number is not.
    expect(parseAmountToMinorUnits("12,34,567", "INR")).toBeNull();
    // Unambiguous grouping still works.
    expect(parseAmountToMinorUnits("1,234", "GBP")).toBe(123400n);
    expect(parseAmountToMinorUnits("1,234,567.89", "GBP")).toBe(123456789n);
  });
});

/**
 * This input is UNTRUSTED — an amount field a customer types, or a cell from an
 * uploaded CSV. CodeQL flagged the original implementation (js/polynomial-redos,
 * high): the trailing strip `/[^\d.,]+$/` could begin matching at every position
 * in a run of junk, so rejecting 100,000 `+` characters took quadratic time and
 * hung the request.
 *
 * The trimming is now a linear scan and long input is refused before any pattern
 * runs at all.
 */
describe("parseAmountToMinorUnits — hostile input", () => {
  it("rejects a pathological string immediately instead of backtracking over it", () => {
    /**
     * ⚠️ THE SHAPE MATTERS, and the obvious one proves nothing.
     *
     * `"+".repeat(n)` is removed wholesale by the LEADING strip, so the
     * trailing pattern never sees it and the old code looked fast. The
     * quadratic case is a junk run that does NOT reach the end — then
     * `[^\d.,]+$` can never succeed and retries from every position.
     *
     * Measured against the old implementation: 5k → 13ms, 10k → 49ms,
     * 20k → 178ms. Doubling the input quadruples the time.
     */
    const hostile = `1${"+".repeat(100_000)}1`;
    const started = Date.now();
    expect(parseAmountToMinorUnits(hostile, "GBP")).toBeNull();
    // Generous by orders of magnitude: the linear scan is microseconds and the
    // length guard rejects this before any pattern runs. A smoke alarm, not a
    // benchmark — it should never fire on a correct implementation.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses anything longer than an amount could be, before matching", () => {
    // 64 is the cap; ₫999,999,999,999.99 with symbol and grouping is under 25.
    expect(parseAmountToMinorUnits("1".repeat(65), "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("1".repeat(64), "JPY")).not.toBeNull();
  });

  it("still trims real packaging now that trimming is not a regex", () => {
    expect(parseAmountToMinorUnits("***12.34***", "GBP")).toBe(1234n);
    expect(parseAmountToMinorUnits("USD 12.34", "USD")).toBe(1234n);
    expect(parseAmountToMinorUnits("...", "GBP")).toBeNull();
    expect(parseAmountToMinorUnits("£", "GBP")).toBeNull();
  });
});

describe("formatMinorUnits", () => {
  it("renders each group at its own width", () => {
    expect(formatMinorUnits(12345n, "KWD")).toBe("12.345");
    expect(formatMinorUnits(1234n, "GBP")).toBe("12.34");
    expect(formatMinorUnits(1000n, "JPY")).toBe("1000");
  });

  it("pads the fraction so 5 fils is not shown as 5 dinars", () => {
    expect(formatMinorUnits(5n, "KWD")).toBe("0.005");
    expect(formatMinorUnits(5n, "GBP")).toBe("0.05");
    expect(formatMinorUnits(1005n, "KWD")).toBe("1.005");
    expect(formatMinorUnits(0n, "GBP")).toBe("0.00");
  });

  it("round-trips with the parser in every group", () => {
    for (const [value, currency] of [
      ["12.345", "KWD"],
      ["1234.56", "GBP"],
      ["1000", "JPY"],
      ["0.001", "OMR"],
      ["999999", "VND"],
    ] as const) {
      const parsed = parseAmountToMinorUnits(value, currency);
      expect(parsed).not.toBeNull();
      expect(formatMinorUnits(parsed!, currency)).toBe(value);
    }
  });
});

describe("outstandingBalance", () => {
  it("is what is left, not the total", () => {
    expect(outstandingBalance(10_000n, 6_000n)).toBe(4_000n);
    expect(outstandingBalance(10_000n, 0n)).toBe(10_000n);
    expect(outstandingBalance(10_000n, 10_000n)).toBe(0n);
  });

  /** Overpayment is allowed (founder ruling). A negative balance would read as
   *  a debt owed the other way and would have Eva chasing a credit. */
  it("clamps at zero on overpayment rather than going negative", () => {
    expect(outstandingBalance(10_000n, 12_500n)).toBe(0n);
  });
});

describe("minorUnitsToNumber", () => {
  it("passes through any realistic invoice, including the ones INTEGER could not hold", () => {
    expect(minorUnitsToNumber(123456n)).toBe(123456);
    // ₫50,000,000,000 — fifty billion dong, about $2m. Overflows a 32-bit
    // INTEGER (max 2,147,483,647), which is why migration 0021 widened the
    // column, and is still exact as a JavaScript number.
    expect(minorUnitsToNumber(50_000_000_000n)).toBe(50_000_000_000);
  });

  it("throws rather than silently losing precision beyond the safe range", () => {
    const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => minorUnitsToNumber(beyond)).toThrow(RangeError);
  });
});
