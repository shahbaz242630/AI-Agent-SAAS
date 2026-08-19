import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OwedPanel } from "@/app/app/invoice-chasing/owed-panel";
import { owedRows, type OwedRow } from "@/products/invoice-follow-up/dashboard";

/**
 * The money on the home screen, actually rendered (Slice 1.9).
 *
 * `renderToStaticMarkup` needs no DOM and no new dependency — the
 * `ReminderStepList` precedent. It does NOT test interaction; there is none
 * here, which is exactly why this component was kept hook-free.
 *
 * Worth rendering rather than unit-testing the formatter alone: the defect this
 * catches is a currency shown at the wrong precision, and that only becomes
 * visible once the number reaches the screen.
 */

const GBP: OwedRow = {
  currency: "GBP",
  invoiceCount: 9,
  outstandingMinorUnits: 150_000,
  overdueMinorUnits: 0,
  overdueCount: 0,
};
const KWD: OwedRow = {
  currency: "KWD",
  invoiceCount: 3,
  outstandingMinorUnits: 4_750_499,
  overdueMinorUnits: 0,
  overdueCount: 0,
};

describe("the owed panel, rendered", () => {
  it("renders a card per currency and never merges them", () => {
    const html = renderToStaticMarkup(<OwedPanel rows={[GBP, KWD]} />);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain("GBP");
    expect(html).toContain("KWD");
  });

  /**
   * ⚠️ THREE DECIMALS FOR KUWAIT. A dinar shown to two is wrong by a factor of
   * ten, and GCC is the next market. 4,750,499 fils is 4,750.499 KWD.
   */
  it("shows each currency at its own precision", () => {
    const html = renderToStaticMarkup(<OwedPanel rows={[GBP, KWD]} />);
    expect(html).toContain("4,750.499");
    expect(html).toContain("1,500.00");
  });

  /** No summing, ever — the two amounts must appear as themselves. */
  it("shows no combined total anywhere on the panel", () => {
    const html = renderToStaticMarkup(<OwedPanel rows={[GBP, KWD]} />);
    // 150,000 + 4,750,499 = 4,900,499 minor units. Any rendering of that,
    // at either currency's precision, would mean somebody added them.
    expect(html).not.toContain("4,900.499");
    expect(html).not.toContain("49,004.99");
    expect(html).toContain("2 currencies");
  });

  it("says an empty book is settled rather than rendering nothing", () => {
    const html = renderToStaticMarkup(<OwedPanel rows={[]} />);
    expect(html).toContain("Nothing outstanding");
    expect(html).not.toContain("<li");
  });

  it("uses the singular for a single invoice", () => {
    const html = renderToStaticMarkup(<OwedPanel rows={[{ ...GBP, invoiceCount: 1 }]} />);
    expect(html).toContain("1 invoice ");
    expect(html).not.toContain("1 invoices");
  });

  describe("how much of it is late", () => {
    /**
     * ⚠️ THE OVERDUE FIGURE IS THE ROW'S OWN CURRENCY, AT ITS OWN PRECISION.
     * A dinar rendered to two decimals is wrong by a factor of ten, and this is
     * a second place the same amount gets formatted — the first was enough to
     * ship the defect once.
     */
    it("shows the overdue slice at the row's own precision", () => {
      const html = renderToStaticMarkup(
        <OwedPanel rows={[{ ...KWD, overdueMinorUnits: 1_250_499, overdueCount: 2 }]} />,
      );
      expect(html).toContain("1,250.499 overdue across 2 invoices");
      // The outstanding figure is still its own number, not replaced.
      expect(html).toContain("4,750.499");
    });

    /**
     * ⚠️ NOTHING OVERDUE PRINTS NOTHING. A "£0.00 overdue" in warning colour
     * reads as a warning at a glance, and every invoice being paid on time is
     * the healthiest state a customer can be in.
     */
    it("says nothing at all when nothing is late", () => {
      const html = renderToStaticMarkup(<OwedPanel rows={[GBP]} />);
      expect(html).not.toContain("overdue");
      expect(html).not.toContain("0.00 ");
    });

    it("uses the singular for a single late invoice", () => {
      const html = renderToStaticMarkup(
        <OwedPanel rows={[{ ...GBP, overdueMinorUnits: 50_000, overdueCount: 1 }]} />,
      );
      expect(html).toContain("overdue across 1 invoice");
      expect(html).not.toContain("1 invoices");
    });

    /**
     * ⚠️ THE END-TO-END SHAPE, BECAUSE THE JOIN IS WHERE THIS GOES WRONG. The
     * two lists come from two API calls, and a book with nothing late in
     * sterling returns a shorter overdue list — pairing them by position would
     * print the Kuwaiti figure under the GBP heading.
     */
    it("keeps each currency's late money under its own heading", () => {
      const rows = owedRows(
        [
          { currency: "GBP", invoiceCount: 9, outstandingMinorUnits: 150_000 },
          { currency: "KWD", invoiceCount: 3, outstandingMinorUnits: 4_750_499 },
        ],
        [{ currency: "KWD", invoiceCount: 2, outstandingMinorUnits: 1_250_499 }],
      );
      const html = renderToStaticMarkup(<OwedPanel rows={rows} />);
      expect(html).toContain("1,250.499 overdue");
      // Sterling has nothing late, so no sterling overdue figure exists at all.
      expect(html).not.toContain("1,250.50");
      expect(html).not.toContain("12,504.99");
    });
  });
});
