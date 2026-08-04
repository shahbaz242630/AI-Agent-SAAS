import { describe, expect, it } from "vitest";
import {
  amountInputValue,
  dateInputValue,
  formatDueDate,
  formatMoney,
  parseAmountInput,
} from "../src/lib/money";

/** The value, when it parsed; throws the message otherwise so a broken case
 *  fails loudly instead of comparing against undefined. */
function minorUnits(raw: string, currency: string): number {
  const result = parseAmountInput(raw, currency);
  if (!result.ok) throw new Error(`Expected ${raw} (${currency}) to parse: ${result.message}`);
  return result.minorUnits;
}

function refusal(raw: string, currency: string): string {
  const result = parseAmountInput(raw, currency);
  if (result.ok)
    throw new Error(
      `Expected ${raw} (${currency}) to be refused, got ${String(result.minorUnits)}`,
    );
  return result.message;
}

describe("amountInputValue — filling an edit form without changing the number", () => {
  /**
   * The property, not a string. Slice 1.6c task 4 puts the stored amount back
   * into the box a human types into, and the only thing that matters is that
   * opening a draft and saving it untouched stores what it started with.
   *
   * One case per exponent group, because a round trip through `/100` and `*100`
   * would pass on GBP and lose the third Kuwaiti digit.
   */
  it("round-trips through the parser in every exponent group", () => {
    for (const [minor, currency] of [
      [12_345, "KWD"],
      [987_654, "KWD"],
      [450_000, "JPY"],
      [123_456, "GBP"],
      [1230, "AED"],
      [5, "GBP"],
    ] as const) {
      const typed = amountInputValue(minor, currency);
      expect(minorUnits(typed, currency)).toBe(minor);
    }
  });

  it("writes the currency's own number of decimals", () => {
    expect(amountInputValue(12_345, "KWD")).toBe("12.345");
    expect(amountInputValue(450_000, "JPY")).toBe("450000");
    expect(amountInputValue(1230, "AED")).toBe("12.30");
  });

  it("carries no symbol and no grouping, unlike the display format", () => {
    // A grouped "1,234.56" in the box would meet the comma ambiguity check on
    // the way back — the parser refuses what it cannot read unambiguously, so
    // an edit form filled that way could not be saved at all.
    const typed = amountInputValue(123_456, "GBP");
    expect(typed).toBe("1234.56");
    expect(typed).not.toContain(",");
    expect(formatMoney(123_456, "GBP")).toContain(",");
  });
});

describe("dateInputValue — the date an edit form opens on", () => {
  it("reads the UTC calendar day, not the reader's", () => {
    // A DATE column arrives as midnight UTC. Taken locally, this is 30 Sep for
    // anyone west of UTC — and an edit form that opens a day early SAVES a day
    // early as soon as any other field is touched.
    expect(dateInputValue("2026-10-01T00:00:00.000Z")).toBe("2026-10-01");
  });

  it("is empty rather than 'Invalid Date' when there is nothing to show", () => {
    expect(dateInputValue("")).toBe("");
    expect(dateInputValue("not a date")).toBe("");
  });
});

describe("parseAmountInput — what a human types becomes minor units", () => {
  it("converts one case per exponent group, which is the point of the whole slice", () => {
    // Plan §6: "A test that only uses GBP cannot fail on the bug this slice
    // exists to prevent."
    expect(minorUnits("12.345", "KWD")).toBe(12_345);
    expect(minorUnits("1000", "JPY")).toBe(1000);
    expect(minorUnits("12.30", "AED")).toBe(1230);
  });

  it("survives the classic floating-point offenders", () => {
    // `Math.round(1.005 * 100)` is 100, not 101 — floats cannot represent
    // 1.005. There is no float anywhere in the parsing path.
    expect(minorUnits("1.005", "KWD")).toBe(1005);
    expect(minorUnits("0.1", "GBP")).toBe(10);
    expect(minorUnits("0.2", "GBP")).toBe(20);
    expect(minorUnits("0.07", "GBP")).toBe(7);
    expect(minorUnits("8.20", "GBP")).toBe(820);
  });

  it("accepts thousands separators and a currency symbol", () => {
    expect(minorUnits("1,234.56", "GBP")).toBe(123_456);
    expect(minorUnits("£1,234.56", "GBP")).toBe(123_456);
    expect(minorUnits("1234.56 AED", "AED")).toBe(123_456);
  });

  it("REFUSES zero, which parses perfectly and is still not an invoice", () => {
    // The trap: `0` is a valid parse, so without an explicit check it sails
    // through to a raw 400 from a field that looked accepted.
    expect(refusal("0", "GBP")).toMatch(/more than zero/i);
    expect(refusal("0.00", "GBP")).toMatch(/more than zero/i);
    expect(refusal("0", "JPY")).toMatch(/more than zero/i);
  });

  it("says WHICH currency's decimals were wrong, rather than 'invalid'", () => {
    // `12.345` is a valid Kuwaiti amount and an invalid British one. Telling a
    // customer their perfectly-formed amount is "invalid" explains nothing.
    expect(refusal("12.345", "GBP")).toMatch(/GBP/);
    expect(refusal("12.345", "GBP")).toMatch(/2 decimal places/);
    expect(refusal("12.3456", "KWD")).toMatch(/KWD.*3 decimal places/);
  });

  it("tells a zero-decimal currency it takes whole numbers, not '0 decimal places'", () => {
    const message = refusal("1000.50", "JPY");
    expect(message).toMatch(/JPY/);
    expect(message).toMatch(/whole number/i);
    expect(message).not.toMatch(/0 decimal places/);
  });

  it("refuses a negative rather than silently flipping its sign", () => {
    // An earlier draft of the shared parser turned `-5.00` into `500n` — a
    // credit becoming a debt Eva would then chase.
    expect(refusal("-5.00", "GBP")).toMatch(/positive/i);
    expect(refusal("(1,234.56)", "GBP")).toMatch(/positive/i);
    expect(refusal("−5.00", "GBP")).toMatch(/positive/i); // U+2212
  });

  it("refuses an ambiguous comma and explains the convention", () => {
    // "1,5" means one and a half to half the world. Guessing wrong overstates
    // the debt tenfold, silently.
    const message = refusal("1,5", "GBP");
    expect(message).toMatch(/full stop|1,234\.56/);
    expect(refusal("1.234,56", "GBP")).toBeTruthy();
  });

  it("asks for an amount when the box is empty", () => {
    expect(refusal("", "GBP")).toMatch(/enter an amount/i);
    expect(refusal("   ", "GBP")).toMatch(/enter an amount/i);
  });

  it("refuses junk without pretending to understand it", () => {
    expect(refusal("abc", "GBP")).toBeTruthy();
    expect(refusal("12.34.56", "GBP")).toBeTruthy();
    // Long untrusted input is refused before any pattern runs (the ReDoS guard).
    expect(refusal("9".repeat(200), "GBP")).toBeTruthy();
  });

  it("never returns a message that is empty or ends mid-sentence", () => {
    for (const bad of ["", "abc", "-1", "0", "12.345", "1,5"]) {
      const message = refusal(bad, "GBP");
      expect(message.length, bad).toBeGreaterThan(10);
      expect(message.trim().endsWith("."), bad).toBe(true);
    }
  });
});

/**
 * Slice 1.6c plan §6: "one case per exponent group: 12.345 KWD → 12345,
 * 1000 JPY → 1000, 12.30 AED → 1230. A test that only uses GBP cannot fail on
 * the bug this slice exists to prevent."
 *
 * These run the other direction — minor units to what a human sees — because
 * that is what a screen does, and a display that divides by 100 is just as
 * wrong as a parser that multiplies by it.
 */
describe("formatMoney", () => {
  it("shows a THREE-decimal currency with three decimals", () => {
    // 12345 minor units of KWD is 12.345 dinar. Two decimals would read as
    // 123.45 — out by a factor of ten, on the currency of the next market.
    expect(formatMoney(12_345, "KWD")).toContain("12.345");
    expect(formatMoney(3_750_500, "KWD")).toContain("3,750.500");
  });

  it("shows a ZERO-decimal currency with no decimals at all", () => {
    // The minor unit IS the yen. 450000 is ¥450,000, not ¥4,500.00.
    const yen = formatMoney(450_000, "JPY");
    expect(yen).toContain("450,000");
    expect(yen).not.toContain("450,000.00");
    expect(yen).not.toContain("4,500");
  });

  it("shows a TWO-decimal currency normally", () => {
    expect(formatMoney(1_230, "AED")).toContain("12.30");
    expect(formatMoney(1_000_000, "AED")).toContain("10,000.00");
    expect(formatMoney(245_000, "GBP")).toContain("2,450.00");
  });

  it("keeps the trailing zero that makes an amount look like money", () => {
    // "12.3" reads as a truncation and invites someone to wonder what was cut.
    expect(formatMoney(1_230, "GBP")).toContain("12.30");
    expect(formatMoney(50_000, "AED")).toContain("500.00");
  });

  it("names the currency, because a bare number is ambiguous across a book", () => {
    // Currency is per invoice, so "4,000.00" alone is unreadable on a list that
    // holds AED and GBP (trap 3b).
    expect(formatMoney(100, "GBP")).toMatch(/£|GBP/);
    expect(formatMoney(100, "AED")).toMatch(/AED/);
    expect(formatMoney(100, "JPY")).toMatch(/¥|JPY/);
  });

  it("handles zero, which is what a fully paid invoice's balance is", () => {
    expect(formatMoney(0, "GBP")).toContain("0.00");
    expect(formatMoney(0, "JPY")).toContain("0");
    expect(formatMoney(0, "KWD")).toContain("0.000");
  });

  it("survives a currency Intl has never heard of instead of taking the page down", () => {
    // A row that cannot be displayed is bad; a row that throws destroys the
    // whole list, including the rows that were fine.
    expect(() => formatMoney(1_234, "XYZ")).not.toThrow();
    expect(() => formatMoney(1_234, "not-a-currency")).not.toThrow();
    expect(formatMoney(1_234, "not-a-currency")).toContain("12.34");
  });

  it("does not lose precision on a large invoice", () => {
    // BIGINT columns exist because a Vietnamese invoice overflowed INTEGER at
    // about $860 under the old ×100 code.
    expect(formatMoney(2_100_000_000, "VND")).toContain("2,100,000,000");
  });
});

describe("formatDueDate", () => {
  it("shows the date the API sent, not the day before it", () => {
    // ⚠️ `due_date` is a DATE column and arrives as midnight UTC. Formatted in
    // a local zone west of UTC it renders as the PREVIOUS day — a due date that
    // is silently a day early for anyone in the Americas.
    expect(formatDueDate("2026-08-03T00:00:00.000Z")).toBe("3 Aug 2026");
    expect(formatDueDate(new Date("2026-01-01T00:00:00.000Z"))).toBe("1 Jan 2026");
    expect(formatDueDate("2026-12-31T00:00:00.000Z")).toBe("31 Dec 2026");
  });

  it("does not fall over on a value it cannot read", () => {
    expect(formatDueDate("not a date")).toBe("—");
  });
});
