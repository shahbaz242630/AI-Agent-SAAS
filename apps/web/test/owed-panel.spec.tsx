import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OwedPanel } from "@/app/app/owed-panel";
import type { CurrencyTotal } from "@/lib/dashboard";

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

const GBP: CurrencyTotal = { currency: "GBP", invoiceCount: 9, outstandingMinorUnits: 150_000 };
const KWD: CurrencyTotal = { currency: "KWD", invoiceCount: 3, outstandingMinorUnits: 4_750_499 };

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
});
