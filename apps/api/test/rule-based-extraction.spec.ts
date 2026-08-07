import { describe, expect, it } from "vitest";
import {
  extractFieldsFromLines,
  groupTextItemsIntoLines,
  toIsoDate,
  type PositionedText,
} from "../src/modules/integrations/extraction/rule-based-extraction.provider.js";
import { parseImportAmount } from "../src/common/ledger/values.js";

/**
 * Rule-based extraction, against the shapes REAL invoices produce.
 *
 * ⚠️ WHY THIS FILE EXISTS. Until 2026-08-05 the extractor had no unit test at
 * all — `invoice-documents.spec.ts` exercises the module around it — and the
 * rules inside it had been written against invoices we invented. Eight of the
 * founder's own documents were run through it and EVERY ONE failed in four
 * ways: no due date, the pre-tax sub total returned as the amount at the
 * highest confidence, the sender's own email returned as the customer's, and
 * the customer's name run together with the dates column. A fifth was found
 * while fixing them: an AED invoice came back with no currency, which confirm
 * defaults to GBP.
 *
 * ⚠️ THE FIXTURES ARE SYNTHETIC, AND DELIBERATELY SO. They reproduce the real
 * documents' LAYOUT — the same labels, the same column arrangement, the same
 * `Sub Total` / `Total AED…` pair, the same lone letterhead email — with
 * invented names, addresses, numbers and domains. The real files are the
 * founder's live business records (they carry a bank account number, a tax
 * registration number and a customer's home address) and **this repository is
 * public**, so they can never be committed. Structure is what the extractor
 * reads; identity is not.
 */

/**
 * The founder's INV-000198 as the extractor sees it, with every identifying
 * value replaced. Column-merged lines are written here already merged, because
 * that is what the PDF text layer produces before `groupTextItemsIntoLines`
 * splits them — the geometry tests below cover the split itself.
 */
const REAL_SHAPE_INVOICE = [
  "TAX INVOICE",
  "# INV-000198",
  "Balance Due",
  "AED0.00",
  "Example Technical Services LLC",
  "Dubai",
  "United Arab Emirates",
  "TRN 100000000000003",
  "billing@example-contractor.test",
  "Bill To",
  "Ms. Alex Rivera",
  "Invoice Date : 10 Apr 2026",
  "Villa 1",
  "Street 2",
  "Terms : Due on Receipt",
  "Due Date : 24 Apr 2026",
  "Dubai",
  "# Item & Description Qty Rate Tax Amount",
  "1 Ceiling works 1.00 32,000.00 30,476.19 1,523.81 32,000.00",
  "Quote Amount -54,000/=",
  "Advanced - 22000/=",
  "2 Pool works 1.00 18,000.00 17,142.86 857.14 18,000.00",
  "Sub Total 47,619.05 2,380.95 50,000.00",
  "Total AED50,000.00",
  "Payment Made (-) 50,000.00",
];

function fields(lines: string[]) {
  return extractFieldsFromLines(lines).fields;
}

describe("toIsoDate", () => {
  it("reads the textual month forms a real invoice uses", () => {
    // ⚠️ THE DEFECT: none of these was recognised, so `Due Date : 10 Apr 2026`
    // produced a due date of null on all eight real documents — the one field
    // a chasing product cannot work without.
    expect(toIsoDate("10 Apr 2026")).toBe("2026-04-10");
    expect(toIsoDate("10 April 2026")).toBe("2026-04-10");
    expect(toIsoDate("10-Apr-2026")).toBe("2026-04-10");
    expect(toIsoDate("Apr 10, 2026")).toBe("2026-04-10");
    expect(toIsoDate("April 10, 2026")).toBe("2026-04-10");
    expect(toIsoDate("1 Sept 2026")).toBe("2026-09-01");
    expect(toIsoDate("3rd March 2026")).toBe(null); // day-first needs the day as digits only
    expect(toIsoDate("March 3rd, 2026")).toBe("2026-03-03");
  });

  it("keeps the day-first reading of a slash date, so no existing date changes meaning", () => {
    // parseImportDate has always read DD/MM/YYYY. Normalising must not quietly
    // turn 10 April into 4 October.
    expect(toIsoDate("10/04/2026")).toBe("2026-04-10");
    expect(toIsoDate("2026-04-10")).toBe("2026-04-10");
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    expect(toIsoDate("31 Feb 2026")).toBe(null);
    expect(toIsoDate("2026-13-01")).toBe(null);
    expect(toIsoDate("32 Jan 2026")).toBe(null);
    expect(toIsoDate("10 Smarch 2026")).toBe(null);
    expect(toIsoDate("")).toBe(null);
    expect(toIsoDate(undefined)).toBe(null);
  });
});

describe("dates from a real invoice's lines", () => {
  it("extracts the due date from a textual month, at label confidence", () => {
    const result = fields(REAL_SHAPE_INVOICE);
    expect(result.dueDate).toEqual({ value: "2026-04-24", confidence: 0.9 });
  });

  it("extracts the issue date separately from the due date", () => {
    const result = fields(REAL_SHAPE_INVOICE);
    expect(result.issueDate).toEqual({ value: "2026-04-10", confidence: 0.9 });
  });

  it("is not fooled by 'Terms : Due on Receipt' into a due date", () => {
    // "Due on Receipt" matches the due label with no date after it. It must not
    // become a date, and it must not stop the real `Due Date :` line being read.
    const result = fields(["Terms : Due on Receipt", "Due Date : 24 Apr 2026"]);
    expect(result.dueDate).toEqual({ value: "2026-04-24", confidence: 0.9 });
  });
});

describe("amount", () => {
  it("returns the invoice TOTAL, not the pre-tax sub total", () => {
    // ⚠️ THE DEFECT, AND THE WORST ONE: 47,619.05 was returned at confidence
    // 0.9 while the document said Total AED50,000.00. `\btotal\b` matches
    // inside "Sub Total", and the value pattern could not see past `AED` to the
    // digits, so the sub total was the only candidate left standing.
    const result = fields(REAL_SHAPE_INVOICE);
    expect(result.amount?.confidence).toBe(0.9);
    expect(parseImportAmount(result.amount!.value!, "AED")).toBe(5_000_000);
  });

  it("does not take the sub total on a DISCOUNTED invoice, where it is the larger figure", () => {
    // ⚠️ THIS IS THE CASE THAT PINS THE "Sub Total" EXCLUSION, and the first
    // version of this file did not have it. On the founder's invoice the sub
    // total is SMALLER than the total, so "largest wins" reached the right
    // answer even with the exclusion removed — the test passed for a reason
    // that had nothing to do with the fix. A discount inverts it: chase 100.00
    // on an invoice discounted to 90.00 and the customer is overcharged.
    const result = fields(["Sub Total 100.00", "Discount -10.00", "Total 90.00"]);
    expect(parseImportAmount(result.amount!.value!, "GBP")).toBe(9000);
  });

  it("does not treat a sub total as the total when the document has no total line", () => {
    // "Sub Total / Tax / Amount Due" with no "Total" line is a common template.
    // Without the exclusion the sub total wins the total tier outright and the
    // tax is never chased.
    //
    // ⚠️ TWO WORDS ON PURPOSE. The single word "Subtotal" was never the problem
    // — `\btotal\b` finds no word boundary inside it — so a test written that
    // way passes whether the exclusion is there or not. It is the spaced and
    // hyphenated forms that need it.
    const result = fields(["Sub Total 100.00", "Tax 20.00", "Amount Due 120.00"]);
    expect(parseImportAmount(result.amount!.value!, "GBP")).toBe(12_000);
  });

  it("excludes the hyphenated 'Sub-Total' too", () => {
    const result = fields(["Sub-Total 100.00", "Tax 20.00", "Amount Due 120.00"]);
    expect(parseImportAmount(result.amount!.value!, "GBP")).toBe(12_000);
  });

  it("does not let a settled 'Balance Due 0.00' outrank the total", () => {
    // INV-000198 is paid in full: it reads `Balance Due AED0.00` AND
    // `Total AED50,000.00`. Preferring the more specific-sounding label would
    // have extracted ZERO — worse than the bug being fixed.
    const result = fields(["Balance Due AED0.00", "Total AED50,000.00"]);
    expect(parseImportAmount(result.amount!.value!, "AED")).toBe(5_000_000);
  });

  it("falls back to the outstanding amount when there is no total at all", () => {
    const result = fields(["Amount Due GBP1,250.00"]);
    expect(result.amount?.confidence).toBe(0.9);
    expect(parseImportAmount(result.amount!.value!, "GBP")).toBe(125_000);
  });

  it("ignores 'Quote Amount' and the table's own 'Amount' header", () => {
    // Bare "Amount" is a column header on every real invoice, and
    // "Quote Amount -54,000/=" is prose inside a line item.
    const result = fields([
      "# Item & Description Qty Rate Tax Amount",
      "Quote Amount -54,000/=",
      "Total GBP120.00",
    ]);
    expect(parseImportAmount(result.amount!.value!, "GBP")).toBe(12_000);
  });

  it("captures all three decimals of a Kuwaiti amount", () => {
    // The money layer was widened for KWD in 1.6c; this capture still stopped
    // at two decimals, which undid it one layer out — 12.345 became 12.34.
    //
    // ⚠️ THE CONFIDENCE IS PART OF THE ASSERTION, and without it this test
    // passes against the broken capture: the fuzzy tier picks the same figure
    // off the page and the value alone cannot tell the two paths apart. 0.9
    // says the LABEL found it.
    const result = fields(["Total KWD 4,750.499"]);
    expect(result.amount?.confidence).toBe(0.9);
    expect(parseImportAmount(result.amount!.value!, "KWD")).toBe(4_750_499);
  });
});

describe("currency", () => {
  it("reads AED off the amount when there is no symbol and no currency label", () => {
    // ⚠️ THE FIFTH DEFECT. These invoices write `Total AED50,000.00` — no
    // symbol, no "Currency:" line — so the field came back ABSENT, and confirm
    // defaults absent to GBP. A Dubai invoice became a sterling one silently.
    const result = fields(REAL_SHAPE_INVOICE);
    expect(result.currency?.value).toBe("AED");
  });

  it("does not mistake a tax registration number for a currency", () => {
    // `TRN 100000000000003` is three capitals against a long number, three
    // lines above the total, on every one of the founder's invoices.
    const result = fields(["TRN 100000000000003", "Total 500.00"]);
    expect(result.currency?.value).not.toBe("TRN");
  });

  it("does not mistake a three-letter word beside a DECIMAL amount for a currency", () => {
    // ⚠️ THIS IS THE ONE THAT PINS THE ALLOWLIST. The TRN test above does not:
    // TRN sits beside an integer, and only amounts with decimals are scanned
    // for a code, so it never reaches the check. A tax line does sit beside a
    // decimal — and "TAX" is three letters.
    const result = fields(["Tax 2,380.95", "Total 50,000.00"]);
    expect(result.currency?.value).not.toBe("TAX");
  });

  it("does not read a currency out of the tail of a longer word", () => {
    // `Total £1,250.00` once yielded the currency "TAL", because the
    // three-letter code was allowed to match the end of "Total". The symbol is
    // the right answer here, and the code must not get in front of it.
    const result = fields(["Total £1,250.00"]);
    expect(result.currency?.value).toBe("GBP");
  });

  it("still prefers an explicit currency label", () => {
    const result = fields(["Currency: SGD", "Total AED50,000.00"]);
    expect(result.currency?.value).toBe("SGD");
  });

  it("still reads a symbol when that is all there is", () => {
    const result = fields(["Total £1,250.00"]);
    expect(result.currency?.value).toBe("GBP");
  });
});

describe("emails", () => {
  it("never returns the sender's own letterhead address as the customer's", () => {
    // ⚠️ THE DEFECT THAT WOULD HAVE EMAILED THE WRONG PERSON. The only email on
    // all eight real invoices is the sender's own, and the old rule was "the
    // first unlabelled email is the customer's" — so Eva would have chased our
    // own customer instead of their debtor.
    const result = extractFieldsFromLines(REAL_SHAPE_INVOICE);
    expect(result.fields.customerEmail).toBeUndefined();
    expect(result.fields.contactEmail).toBeUndefined();
  });

  it("says in the notes what it found, so the reviewer is not left guessing", () => {
    const result = extractFieldsFromLines(REAL_SHAPE_INVOICE);
    expect(result.notes.join(" ")).toContain("billing@example-contractor.test");
  });

  it("still takes an email a label attributes to the customer", () => {
    const result = fields(["Customer Email: ap@debtor.test"]);
    expect(result.customerEmail).toEqual({ value: "ap@debtor.test", confidence: 0.9 });
  });

  it("still takes a contact email by its label", () => {
    const result = fields(["Attn: ap@debtor.test"]);
    expect(result.contactEmail).toEqual({ value: "ap@debtor.test", confidence: 0.9 });
  });
});

describe("customer name", () => {
  it("takes the name under 'Bill To' without the next column's label", () => {
    const result = fields(REAL_SHAPE_INVOICE);
    expect(result.customerName).toEqual({ value: "Ms. Alex Rivera", confidence: 0.9 });
  });

  it("looks past a date line when the two columns interleave by height", () => {
    // ⚠️ THE SECOND NAME DEFECT, AND COLUMN SPLITTING DOES NOT FIX IT. On
    // INV-000208 the right-hand column's first row sits a few points HIGHER
    // than the customer's name, so reading order puts the invoice date between
    // "Bill To" and "Mr. Ben". Taking the next line blindly returned
    // "Invoice Date : 02 Aug 2026" as the customer's name — on two of the eight
    // real documents.
    const result = fields(["Bill To", "Invoice Date : 02 Aug 2026", "Mr. Ben"]);
    expect(result.customerName).toEqual({ value: "Mr. Ben", confidence: 0.9 });
  });

  it("looks past an expiry-date line too", () => {
    const result = fields(["Bill To", "Expiry Date : 08 Jul 2026", "Atos Origin Fz Llc"]);
    expect(result.customerName?.value).toBe("Atos Origin Fz Llc");
  });

  it("gives up rather than walking into the address when there is no name", () => {
    // The lookahead is bounded. A document whose party block is all labels must
    // report "no name" — an address returned as a company name is the same
    // class of confident wrong answer as the date was.
    const result = fields([
      "Bill To",
      "Invoice Date : 02 Aug 2026",
      "Due Date : 02 Aug 2026",
      "Terms : Due on Receipt",
      "Villa 820",
    ]);
    expect(result.customerName).toEqual({ value: null, confidence: 0 });
  });

  it("cuts a name short at another field's label if the columns were not split", () => {
    // Defence in depth: where the horizontal gap is too small to read as a
    // column, the name would otherwise absorb the dates column wholesale —
    // "Mr. Nicolas Invoice Date : 10 Apr 2026" is the real example.
    const result = fields(["Bill To", "Ms. Alex Rivera Invoice Date : 10 Apr 2026"]);
    expect(result.customerName?.value).toBe("Ms. Alex Rivera");
  });
});

describe("groupTextItemsIntoLines", () => {
  const A4_WIDTH = 595;

  function run(items: PositionedText[]): string[] {
    return groupTextItemsIntoLines(items, A4_WIDTH);
  }

  it("splits a row into columns at a real column gap", () => {
    // ⚠️ MEASURED FROM THE REAL DOCUMENT: the name column ends at x≈120 and the
    // dates column starts at x≈411 — a gap of 290 on a 595-wide page.
    const lines = run([
      { x: 53, y: 600, width: 67, str: "Ms. Alex Rivera" },
      { x: 411, y: 600, width: 74, str: "Invoice Date :" },
      { x: 544, y: 600, width: 51, str: "10 Apr 2026" },
    ]);
    expect(lines).toEqual(["Ms. Alex Rivera", "Invoice Date : 10 Apr 2026"]);
  });

  it("does NOT split a label from its own value across a 59-unit gap", () => {
    // The same document's `Due Date :` → `10 Apr 2026` gap. Splitting here
    // would break the very field the split exists to rescue.
    const lines = run([
      { x: 411, y: 560, width: 74, str: "Due Date :" },
      { x: 544, y: 560, width: 51, str: "10 Apr 2026" },
    ]);
    expect(lines).toEqual(["Due Date : 10 Apr 2026"]);
  });

  it("keeps a totals row whole", () => {
    // `Sub Total 47,619.05 2,380.95 50,000.00` — gaps of 21 and 37 units.
    const lines = run([
      { x: 300, y: 300, width: 40, str: "Sub Total" },
      { x: 361, y: 300, width: 50, str: "47,619.05" },
      { x: 432, y: 300, width: 45, str: "2,380.95" },
      { x: 514, y: 300, width: 50, str: "50,000.00" },
    ]);
    expect(lines).toEqual(["Sub Total 47,619.05 2,380.95 50,000.00"]);
  });

  it("orders rows top-to-bottom and columns left-to-right", () => {
    const lines = run([
      { x: 411, y: 600, width: 60, str: "right" },
      { x: 53, y: 600, width: 40, str: "left" },
      { x: 53, y: 700, width: 40, str: "above" },
    ]);
    expect(lines).toEqual(["above", "left", "right"]);
  });

  it("groups runs whose baselines differ by a rounding wobble", () => {
    const lines = run([
      { x: 53, y: 600, width: 30, str: "one" },
      { x: 90, y: 602, width: 30, str: "line" },
    ]);
    expect(lines).toEqual(["one line"]);
  });

  it("drops empty runs rather than producing blank lines", () => {
    const lines = run([
      { x: 53, y: 600, width: 30, str: "   " },
      { x: 53, y: 580, width: 30, str: "kept" },
    ]);
    expect(lines).toEqual(["kept"]);
  });
});
