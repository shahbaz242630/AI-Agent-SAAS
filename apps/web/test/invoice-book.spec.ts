import { describe, expect, it } from "vitest";
import {
  ageingBucketLabel,
  bookFilterLine,
  bookTotalLine,
  chaseTimingLine,
  defaultBookCurrency,
  otherCurrenciesLine,
} from "../src/lib/invoice-book";

/** A fixed formatter, so these test the SENTENCE and not `Intl`. */
const formatDate = (value: string) => `on ${value.slice(0, 10)}`;

describe("ageing labels", () => {
  it("says how late the money is, in words", () => {
    expect(ageingBucketLabel("days_1_15")).toBe("1–15 days late");
    expect(ageingBucketLabel("days_over_45")).toMatch(/over 45 days/i);
  });

  /**
   * ⚠️ "Current" IS AN ACCOUNTING WORD THAT MEANS THE OPPOSITE TO EVERYONE
   * ELSE. In a book it means "not yet due"; on a screen it reads as "the
   * current one". The whole column is about lateness, so the label says that.
   */
  it("does not call an invoice that is not due yet 'current'", () => {
    expect(ageingBucketLabel("current")).toBe("Not due yet");
    expect(ageingBucketLabel("current")).not.toMatch(/current/i);
  });

  it("says something honest about a bucket it has never heard of", () => {
    // The web app can be older than the API it is talking to.
    expect(ageingBucketLabel("days_46_60")).toBe("Unknown");
  });
});

describe("which currency the book opens on", () => {
  /**
   * ⚠️ FOUND ON SCREEN. The first version ranked by outstanding minor units,
   * which is a comparison ACROSS currencies — the one thing this slice exists
   * to stop. KWD has three decimals, so 4,750.499 KWD is 4,750,499 fils and
   * beat a much larger sterling book measured in pence. The founder's page
   * opened on three Kuwaiti invoices and hid everything else.
   */
  it("ranks by invoice count, because minor units are not comparable across currencies", () => {
    const currencies = [
      // Bigger NUMBER, three decimals, three invoices.
      { currency: "KWD", invoiceCount: 3, outstandingMinorUnits: 4_750_499 },
      // Smaller number, two decimals, far more of the book.
      { currency: "GBP", invoiceCount: 9, outstandingMinorUnits: 1_500_000 },
    ];
    expect(defaultBookCurrency(currencies)).toBe("GBP");
  });

  it("honours an explicit choice, uppercased", () => {
    const currencies = [
      { currency: "GBP", invoiceCount: 9, outstandingMinorUnits: 1 },
      { currency: "AED", invoiceCount: 1, outstandingMinorUnits: 1 },
    ];
    expect(defaultBookCurrency(currencies, "aed")).toBe("AED");
  });

  it("breaks ties the same way every time", () => {
    const tied = [
      { currency: "SGD", invoiceCount: 2, outstandingMinorUnits: 5 },
      { currency: "AED", invoiceCount: 2, outstandingMinorUnits: 9 },
    ];
    expect(defaultBookCurrency(tied)).toBe("AED");
    expect(defaultBookCurrency([...tied].reverse())).toBe("AED");
  });

  it("falls back to GBP on an empty book rather than crashing", () => {
    expect(defaultBookCurrency([])).toBe("GBP");
  });
});

describe("the money at the top of the book", () => {
  it("names the currency and agrees with itself on number", () => {
    expect(
      bookTotalLine({ currency: "GBP", formattedOutstanding: "£2,500.00", invoiceCount: 1 }),
    ).toContain("1 invoice");
    expect(
      bookTotalLine({ currency: "GBP", formattedOutstanding: "£2,500.00", invoiceCount: 7 }),
    ).toContain("7 invoices");
  });

  it("says nothing is outstanding rather than showing a zero", () => {
    const line = bookTotalLine({
      currency: "AED",
      formattedOutstanding: "AED 0.00",
      invoiceCount: 0,
    });
    expect(line).toMatch(/nothing outstanding in AED/i);
    expect(line).not.toContain("0 invoices");
  });

  /**
   * ⚠️ THE LINE THAT STOPS THE FOUNDER'S CHOICE HIDING MONEY. Totals are shown
   * one currency at a time (ruling 2026-08-04). That is only safe while the
   * screen says the other currencies are there — a UK seller with buyers in
   * Singapore and the UAE must not read "£2,500 outstanding" as everything
   * they are owed.
   */
  it("names every other currency in the book", () => {
    const currencies = [{ currency: "GBP" }, { currency: "AED" }, { currency: "SGD" }];
    const line = otherCurrenciesLine(currencies, "GBP");
    expect(line).toContain("AED");
    expect(line).toContain("SGD");
    expect(line).not.toContain("GBP");
    // Reads as English, not as a list literal.
    expect(line).toMatch(/AED and SGD/);
  });

  it("uses the singular when there is one other currency", () => {
    expect(otherCurrenciesLine([{ currency: "GBP" }, { currency: "AED" }], "GBP")).toMatch(
      /money in AED\.$/,
    );
  });

  it("stays silent when the book is in one currency", () => {
    expect(otherCurrenciesLine([{ currency: "GBP" }], "GBP")).toBeNull();
    expect(otherCurrenciesLine([], "GBP")).toBeNull();
  });
});

describe("what the chasing column says", () => {
  /**
   * ⚠️ AN EMPTY `lastChasedOn` IS NOT "NEVER CHASED" — and will be empty for
   * EVERY invoice until slice 1.7 exists, because nothing sends yet. Reporting
   * it as "never chased" would be a product-wide lie told 100% of the time.
   */
  it("never claims an invoice has not been chased just because nothing was sent", () => {
    const line = chaseTimingLine({
      isChased: true,
      lastChasedOn: null,
      nextChaseOn: "2026-08-08",
      formatDate,
    });
    expect(line).toMatch(/due to be chased/i);
    expect(line).not.toMatch(/never|not chased/i);
  });

  it("reports the last send and the next one together once sending exists", () => {
    const line = chaseTimingLine({
      isChased: true,
      lastChasedOn: "2026-07-28",
      nextChaseOn: "2026-08-08",
      formatDate,
    });
    expect(line).toContain("2026-07-28");
    expect(line).toContain("2026-08-08");
  });

  it("flags a chased invoice with nothing queued, which is a real fault", () => {
    // This is what an invoice looks like when its schedule never got built.
    expect(
      chaseTimingLine({ isChased: true, lastChasedOn: null, nextChaseOn: null, formatDate }),
    ).toMatch(/no reminders scheduled/i);
  });

  it("stays quiet on an invoice nobody is chasing", () => {
    expect(
      chaseTimingLine({ isChased: false, lastChasedOn: null, nextChaseOn: null, formatDate }),
    ).toBe("—");
  });
});

describe("what the table says it is showing", () => {
  it("mentions paging only when there is paging", () => {
    expect(bookFilterLine({ totalCount: 15, showing: 15 })).toBe("15 invoices.");
    expect(bookFilterLine({ totalCount: 120, showing: 50 })).toBe("Showing 50 of 120 invoices.");
    expect(bookFilterLine({ totalCount: 1, showing: 1 })).toBe("1 invoice.");
  });

  it("distinguishes an empty book from an empty search", () => {
    // "No results" for a book nobody has filled in yet reads as a failure.
    expect(bookFilterLine({ totalCount: 0, showing: 0 })).toMatch(/no invoices yet/i);
    expect(bookFilterLine({ totalCount: 0, showing: 0, search: "acme" })).toContain("acme");
    expect(bookFilterLine({ totalCount: 0, showing: 0, status: "overdue" })).toMatch(
      /no invoices in that state/i,
    );
  });
});
