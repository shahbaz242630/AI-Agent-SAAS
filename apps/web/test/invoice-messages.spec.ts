import { describe, expect, it } from "vitest";
import { invoiceCountLine, noInvoicesLine } from "../src/lib/invoice-messages";

describe("invoiceCountLine", () => {
  it("agrees in number — the branch this project has shipped wrong before", () => {
    // "lowering to 1 seats" reached staging through a fully green gate.
    expect(invoiceCountLine(1, "Perrin Construction Ltd")).toContain("1 invoice for");
    expect(invoiceCountLine(1, "Perrin Construction Ltd")).not.toContain("1 invoices");
    expect(invoiceCountLine(2, "Perrin Construction Ltd")).toContain("2 invoices for");
    expect(invoiceCountLine(17, "Perrin Construction Ltd")).toContain("17 invoices for");
  });

  it("does not read as a failure when there is nothing to chase", () => {
    // Zero invoices is a normal state for a client who pays up front, not a
    // search that came back empty.
    const line = invoiceCountLine(0, "Northwind Trading Ltd");
    expect(line).toContain("Northwind Trading Ltd");
    expect(line).not.toMatch(/no results|not found|error|failed/i);
    // And it must not claim a count it does not have.
    expect(line).not.toContain("0 invoice");
  });

  it("says Eva chases the balance, not the total", () => {
    // The one claim a credit controller has to believe, and this list is the
    // first place they meet it.
    expect(invoiceCountLine(3, "Gulf Interiors LLC")).toMatch(/what is left/i);
    expect(invoiceCountLine(3, "Gulf Interiors LLC")).not.toMatch(/the full amount/i);
  });

  it("names the client, so a bookmarked page is not anonymous", () => {
    for (const count of [0, 1, 5]) {
      expect(invoiceCountLine(count, "Sakura Kikai KK"), String(count)).toContain(
        "Sakura Kikai KK",
      );
    }
  });
});

describe("noInvoicesLine", () => {
  it("says there are none yet, rather than implying a failed lookup", () => {
    const line = noInvoicesLine("Al Mutawa Contracting WLL");
    expect(line).toContain("Al Mutawa Contracting WLL");
    expect(line).not.toMatch(/no results|not found|error/i);
  });
});
