import { describe, expect, it } from "vitest";
import {
  ageingBucketLabel,
  bookFilterLine,
  bookMoneyPanel,
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

describe("which list feeds the picker and which feeds the figure", () => {
  /**
   * A filtered book: the whole book is 250,000 in GBP, the filter caught
   * 220,000 of it — and 40,000 of THAT is money nobody is collecting, so only
   * 180,000 across 4 invoices may be called outstanding.
   */
  const book = {
    chasedByCurrency: [
      { currency: "AED", invoiceCount: 1, outstandingMinorUnits: 100_000 },
      { currency: "GBP", invoiceCount: 7, outstandingMinorUnits: 250_000 },
    ],
    matchedByCurrency: [{ currency: "GBP", invoiceCount: 5, outstandingMinorUnits: 220_000 }],
    collectableByCurrency: [{ currency: "GBP", invoiceCount: 4, outstandingMinorUnits: 180_000 }],
  };

  /**
   * ⚠️ THE THREE LISTS ARE THE SAME SHAPE AND SWAPPING THEM TYPECHECKS. That is
   * the entire reason this is a function with a test rather than two lines in
   * an async server component nothing can render.
   */
  it("takes the figure from the FILTERED list, not the whole book", () => {
    const panel = bookMoneyPanel(book);
    expect(panel.money?.outstandingMinorUnits).toBe(180_000);
    expect(panel.money?.invoiceCount).toBe(4);
  });

  /**
   * ⚠️ AND FROM THE COLLECTABLE LIST, NOT MERELY THE MATCHED ONE. Both follow
   * the filters, so both look right; only one excludes the money nobody is
   * chasing. 220,000 is the number that shipped and was wrong.
   */
  it("takes the figure from the COLLECTABLE list, not everything the filter matched", () => {
    expect(bookMoneyPanel(book).money?.outstandingMinorUnits).not.toBe(220_000);
  });

  /**
   * ⚠️ THE PICKER MUST KEEP NAMING CURRENCIES THE FILTER EXCLUDED. Here the
   * filter matched no dirhams at all — and AED must still be offered, or a
   * customer looking at sterling is silently told their AED book is gone.
   */
  it("keeps every chased currency in the picker, even ones the filter missed", () => {
    const panel = bookMoneyPanel(book);
    expect(panel.currencies.map((row) => row.currency)).toEqual(["AED", "GBP"]);
  });

  /**
   * The default currency is ranked by invoice COUNT over the whole book — using
   * the filtered list would move the page between currencies as the tabs are
   * clicked, which is a screen that will not sit still.
   */
  it("picks the default currency from the whole book, not the filtered slice", () => {
    expect(bookMoneyPanel(book).selectedCurrency).toBe("GBP");
    expect(bookMoneyPanel(book, "aed").selectedCurrency).toBe("AED");
  });

  /**
   * Selecting a currency the filter matched nothing in is a real state — "no
   * overdue dirhams" — and must read as a zero, never as a crash or as the
   * whole book's dirham figure leaking through.
   */
  it("returns nothing when the filter matched none of the chosen currency", () => {
    const panel = bookMoneyPanel(book, "AED");
    expect(panel.money).toBeUndefined();
    expect(
      bookTotalLine({
        currency: panel.selectedCurrency,
        formattedOutstanding: "AED 0.00",
        invoiceCount: panel.money?.invoiceCount ?? 0,
        view: "overdue",
      }),
    ).toBe("Nothing overdue in AED.");
  });

  /**
   * ⚠️ THE PRODUCTION BUG OF 2026-08-12, IN NUMBERS. The founder's book held
   * exactly one invoice and it had been CANCELLED. The book screen read
   * "£4,525.00 outstanding across 1 invoice" while the home screen, on the same
   * data, correctly said nothing was outstanding — two screens disagreeing
   * about money, and the wrong one flattering us.
   *
   * The unfiltered view is not the safe default it was assumed to be: it is the
   * only view that contains cancelled invoices.
   */
  const cancelledOnly = {
    chasedByCurrency: [],
    matchedByCurrency: [{ currency: "GBP", invoiceCount: 1, outstandingMinorUnits: 452_500 }],
    collectableByCurrency: [],
  };

  it("never calls a cancelled invoice money the business is owed", () => {
    const panel = bookMoneyPanel(cancelledOnly);
    expect(panel.money).toBeUndefined();
    expect(
      bookTotalLine({
        currency: panel.selectedCurrency,
        formattedOutstanding: "£0.00",
        invoiceCount: panel.money?.invoiceCount ?? 0,
      }),
    ).toBe("Nothing outstanding in GBP.");
  });

  /**
   * The other half of the rule: the money is not hidden, it is only refused the
   * word "outstanding". Ask for cancelled invoices BY NAME and the figure is
   * both shown and correctly labelled.
   */
  it("still totals cancelled money under a heading that asks for it", () => {
    const panel = bookMoneyPanel(cancelledOnly, undefined, "cancelled");
    expect(panel.money?.outstandingMinorUnits).toBe(452_500);
    expect(
      bookTotalLine({
        currency: panel.selectedCurrency,
        formattedOutstanding: "£4,525.00",
        invoiceCount: panel.money?.invoiceCount ?? 0,
        view: "cancelled",
      }),
    ).toBe("£4,525.00 in cancelled invoices, across 1 invoice.");
  });

  /**
   * Drafts are the case the original wording guard was written for, and it must
   * keep working: a draft is not outstanding either, and its own view says so.
   */
  it("keeps the drafts view reading from the matched list", () => {
    const drafts = {
      chasedByCurrency: [{ currency: "GBP", invoiceCount: 2, outstandingMinorUnits: 50_000 }],
      matchedByCurrency: [{ currency: "GBP", invoiceCount: 3, outstandingMinorUnits: 90_000 }],
      collectableByCurrency: [],
    };
    expect(bookMoneyPanel(drafts, undefined, "draft").money?.outstandingMinorUnits).toBe(90_000);
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
   * ⚠️ THE MONEY FOLLOWS THE FILTER, SO THE SENTENCE MUST NAME THE FILTER.
   * This panel sits directly above a table the view tabs filter. Showing
   * whole-book money over an "Overdue" list put "£2,600.00 outstanding across
   * 3 invoices" above "1 invoice" — two numbers that looked like they
   * disagreed, one of them answering a question nobody had asked.
   */
  it("names the view it is counting, so the figure cannot be misread", () => {
    const money = { currency: "GBP", formattedOutstanding: "£2,200.00", invoiceCount: 2 };
    expect(bookTotalLine({ ...money, view: "overdue" })).toBe(
      "£2,200.00 overdue across 2 invoices.",
    );
    expect(bookTotalLine({ ...money, view: "due_today" })).toContain("due today");
    expect(bookTotalLine({ ...money, view: "due_soon" })).toContain("due soon");
  });

  /**
   * ⚠️ A DRAFT IS NOT OUTSTANDING. Nobody has been sent it, so no money in it
   * is owed — and calling it outstanding overstates the book in the direction
   * that flatters us, in the one figure a business reads first.
   */
  it("never calls draft money outstanding", () => {
    const line = bookTotalLine({
      currency: "GBP",
      formattedOutstanding: "£880.00",
      invoiceCount: 1,
      view: "draft",
    });
    expect(line).toContain("in drafts");
    expect(line).not.toContain("outstanding");
  });

  it("keeps the plain wording when no view is chosen", () => {
    const money = { currency: "GBP", formattedOutstanding: "£2,500.00", invoiceCount: 7 };
    expect(bookTotalLine(money)).toContain("outstanding across");
    expect(bookTotalLine({ ...money, view: undefined })).toContain("outstanding across");
  });

  /**
   * The status comes off a URL anybody can edit. A mistyped query string must
   * not take the screen down — it falls back to the plain wording.
   */
  it("falls back rather than throwing on a view it does not know", () => {
    const line = bookTotalLine({
      currency: "GBP",
      formattedOutstanding: "£2,500.00",
      invoiceCount: 7,
      view: "not-a-real-view",
    });
    expect(line).toContain("outstanding across 7 invoices");
  });

  it("says nothing matched in the view's own words, not the book's", () => {
    const empty = { currency: "GBP", formattedOutstanding: "£0.00", invoiceCount: 0 };
    expect(bookTotalLine({ ...empty, view: "overdue" })).toBe("Nothing overdue in GBP.");
    expect(bookTotalLine({ ...empty, view: "draft" })).toBe("No drafts in GBP.");
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
