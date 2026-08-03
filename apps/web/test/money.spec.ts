import { describe, expect, it } from "vitest";
import { formatDueDate, formatMoney } from "../src/lib/money";

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
