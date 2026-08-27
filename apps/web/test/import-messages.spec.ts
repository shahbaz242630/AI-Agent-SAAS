import { describe, expect, it } from "vitest";
import { autoMapHeaders, IMPORT_CANONICAL_FIELDS } from "@eva/validation";
import {
  ADVERTISED_IMPORT_FIELDS,
  FIELD_LABELS,
  importConfirmLabel,
  importConfirmedLine,
  importFieldLabel,
  importReadLine,
  importRowStatusLabel,
  isImportableRowStatus,
} from "../src/products/invoice-follow-up/import-messages";

describe("what the file turned out to contain", () => {
  /**
   * ⚠️ EVERY ROW IS ACCOUNTED FOR. Reporting only what will import is how
   * somebody uploads two hundred rows, reads "180 ready", confirms, and never
   * learns what happened to the other twenty.
   */
  it("accounts for rows that will NOT import, not just the ones that will", () => {
    const line = importReadLine({
      totalRows: 20,
      validRows: 15,
      invalidRows: 2,
      duplicateRows: 2,
      suppressedRows: 1,
    });
    expect(line).toContain("20 rows");
    expect(line).toContain("15 ready");
    expect(line).toContain("2 already on file");
    expect(line).toContain("1 marked do not contact");
    expect(line).toContain("2 that need fixing");
  });

  it("stays quiet about categories with nothing in them", () => {
    const clean = importReadLine({
      totalRows: 15,
      validRows: 15,
      invalidRows: 0,
      duplicateRows: 0,
      suppressedRows: 0,
    });
    expect(clean).toBe("15 rows read: 15 ready to import.");
  });

  it("says an empty file is empty rather than reporting zeroes", () => {
    const line = importReadLine({
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      duplicateRows: 0,
      suppressedRows: 0,
    });
    expect(line).toMatch(/no rows/i);
    expect(line).not.toContain("0 ready");
  });

  /**
   * ⚠️ READ ON SCREEN, NOT CAUGHT HERE — the first version of this test only
   * exercised the plural, so it shipped "1 that need fixing" to a real preview.
   * Same disagreement as "lowering to 1 seats", which this project has now
   * produced three times. EVERY count branch gets a singular case.
   */
  it("agrees with itself on singular and plural, in every branch", () => {
    const one = importReadLine({
      totalRows: 1,
      validRows: 0,
      invalidRows: 1,
      duplicateRows: 0,
      suppressedRows: 0,
    });
    expect(one).toContain("1 row read");
    expect(one).toContain("1 that needs fixing");
    expect(one).not.toContain("1 that need fixing");

    const many = importReadLine({
      totalRows: 4,
      validRows: 0,
      invalidRows: 2,
      duplicateRows: 1,
      suppressedRows: 1,
    });
    expect(many).toContain("4 rows read");
    expect(many).toContain("2 that need fixing");
  });
});

describe("the confirm button", () => {
  it("says exactly how many invoices it will create", () => {
    expect(importConfirmLabel(15)).toBe("Import 15 invoices");
    expect(importConfirmLabel(1)).toBe("Import 1 invoice");
  });

  it("does not offer to import nothing", () => {
    expect(importConfirmLabel(0)).toBe("Nothing to import");
    expect(importConfirmLabel(0)).not.toMatch(/^Import \d/);
  });
});

describe("what it says after importing", () => {
  /**
   * ⚠️ IT MUST SAY "DRAFTS". The importer creates DRAFT invoices, so nothing is
   * chased until somebody starts them. That is the safe behaviour and entirely
   * invisible unless it is said — somebody who uploads two hundred invoices and
   * assumes Eva is now chasing them would find out weeks later.
   */
  it("says the invoices are drafts and that nothing is being chased yet", () => {
    const line = importConfirmedLine(15, 0);
    expect(line).toMatch(/drafts/i);
    expect(line).toMatch(/nothing is being chased yet/i);
  });

  it("says how many rows were left out, so they are not silently lost", () => {
    const line = importConfirmedLine(15, 5);
    expect(line).toContain("15 invoices");
    expect(line).toMatch(/5 rows were left out/i);
  });

  it("does not mention leftovers when there were none", () => {
    expect(importConfirmedLine(15, 0)).not.toMatch(/left out/i);
  });

  it("says plainly when nothing was imported", () => {
    const line = importConfirmedLine(0, 3);
    expect(line).toMatch(/nothing was imported/i);
    expect(line).not.toMatch(/drafts/i);
  });
});

describe("row statuses in words", () => {
  /**
   * ⚠️ "suppressed" MEANS THE CONTACT ASKED NEVER TO BE EMAILED — a permanent,
   * cross-channel decision. A customer reading the API's own word would guess
   * almost anything.
   */
  it("translates the API's words into a customer's", () => {
    expect(importRowStatusLabel("valid")).toBe("Ready");
    expect(importRowStatusLabel("duplicate")).toBe("Already on file");
    expect(importRowStatusLabel("suppressed")).toBe("Do not contact");
    expect(importRowStatusLabel("invalid")).toBe("Needs fixing");
    // Never the raw word.
    expect(importRowStatusLabel("suppressed")).not.toMatch(/suppress/i);
  });

  it("passes an unrecognised status through rather than hiding it", () => {
    // The web app can be older than the API it is talking to; showing the raw
    // word is worse copy and better than showing nothing.
    expect(importRowStatusLabel("quarantined")).toBe("quarantined");
  });

  it("counts only 'valid' rows as ones that will become invoices", () => {
    expect(isImportableRowStatus("valid")).toBe(true);
    for (const status of ["invalid", "duplicate", "suppressed", "skipped", "imported"]) {
      expect(isImportableRowStatus(status)).toBe(false);
    }
  });
});

describe("column names", () => {
  it("names the canonical fields the way a person would", () => {
    expect(importFieldLabel("invoiceNumber")).toBe("Invoice number");
    expect(importFieldLabel("customerReference")).toBe("Your client reference");
    expect(importFieldLabel("issueDate")).toBe("Invoice date");
  });

  it("shows an unknown field rather than dropping it", () => {
    expect(importFieldLabel("vatNumber")).toBe("vatNumber");
  });
});

/**
 * The upload screen's promise, held against the thing that keeps it.
 *
 * ⚠️ THIS IS THE GUARD FOR A DEFECT THAT SHIPPED. The screen prints a list of
 * "Columns Eva understands" from `FIELD_LABELS`; the matcher recognises headings
 * from its own alias table. Nothing connected the two, and two labels — "Client
 * email" and "Your client reference" — were never aliases at all. A file using
 * the exact headings we recommend had both columns dropped, silently: the row
 * detail still echoed the raw value, so it looked read.
 *
 * ⚠️ IT IMPORTS THE MATCHER FROM `@eva/validation`, which is where it now lives
 * precisely so a web test can reach it. It used to sit in `apps/api`, on the
 * other side of a boundary no test crossed — which is why nothing caught this.
 */
describe("every column the upload screen advertises", () => {
  it("is a heading the importer actually recognises", () => {
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
      expect(autoMapHeaders([label])).toEqual({ [label]: field });
    }
  });

  /**
   * The wording a person is shown says "client"; the code says "customer".
   * That gap is the whole trap — `customerName` already accepted "client name",
   * which made the two that did not look deliberate rather than missed.
   */
  it("accepts the customer's fields whether a person writes client or customer", () => {
    for (const [clientWording, customerWording] of [
      ["Client name", "Customer name"],
      ["Client email", "Customer email"],
      ["Client reference", "Customer reference"],
    ]) {
      expect(Object.values(autoMapHeaders([clientWording!]))).toEqual(
        Object.values(autoMapHeaders([customerWording!])),
      );
      expect(Object.values(autoMapHeaders([clientWording!]))).toHaveLength(1);
    }
  });

  it("still reads a spreadsheet that never heard of us", () => {
    // The headings a real accounts file arrives with, none of them ours.
    expect(autoMapHeaders(["Inv No", "Total", "Due", "Company", "Attn"])).toEqual({
      "Inv No": "invoiceNumber",
      Total: "amount",
      Due: "dueDate",
      Company: "customerName",
      Attn: "contactName",
    });
  });

  /**
   * 🚨 THE CHIPS ARE THE ADVICE, AND A FIELD WITHOUT A LABEL PRINTS ITS OWN
   * VARIABLE NAME. `UNDERSTOOD_FIELDS` on the upload screen is now
   * `IMPORT_CANONICAL_FIELDS` itself, so a field added to the matcher appears
   * on screen the same day — as "customerPhone" rather than "Client phone"
   * unless somebody also adds the wording. The test above proves every LABEL
   * is understood; this one proves every UNDERSTOOD FIELD has a label, which
   * is the other direction and was the hole the 2026-08-18 defect fell through.
   */
  /**
   * 🚨 "WE STOPPED MENTIONING IT" AND "WE STOPPED SUPPORTING IT" ARE DIFFERENT
   * PROMISES TO BREAK.
   *
   * Founder, 2026-08-27: *"no need to duplicate"*. So the contact's email and
   * phone came off the advertised chip list — the client's columns do the same
   * job for everybody now that Eva falls back to the client's address. A file
   * that already uses the contact headings must keep importing exactly as it
   * did, silently and correctly; a customer who built their export around our
   * old advice should never find out we changed our minds.
   */
  it("still reads the columns it no longer advertises", () => {
    const advertised = new Set(ADVERTISED_IMPORT_FIELDS);
    const dropped = IMPORT_CANONICAL_FIELDS.filter((field) => !advertised.has(field));

    expect(dropped, "nothing was dropped — this test is guarding nothing").not.toHaveLength(0);
    for (const field of dropped) {
      const label = FIELD_LABELS[field]!;
      expect(autoMapHeaders([label]), `${label} is no longer read`).toEqual({ [label]: field });
    }
  });

  it("advertises the client's address, which is the one that works for everybody", () => {
    expect(ADVERTISED_IMPORT_FIELDS).toContain("customerEmail");
    expect(ADVERTISED_IMPORT_FIELDS).toContain("customerPhone");
  });

  it("has a human wording for every field the importer understands", () => {
    for (const field of IMPORT_CANONICAL_FIELDS) {
      expect(FIELD_LABELS[field], `${field} would print as its own variable name`).toBeDefined();
      expect(importFieldLabel(field)).not.toBe(field);
    }
  });
});

/**
 * 🚨 THE MONEY BUG THIS WHOLE CHANGE EXISTS TO PREVENT.
 *
 * Founder, 2026-08-27: Eva needs the amount OUTSTANDING. Real exports carry
 * the invoice total and the balance still owed side by side, and the matcher
 * used to take whichever column came first. On a part-paid invoice the total
 * is bigger than the debt — so Eva would chase a customer's customer for money
 * they had already sent, from that customer's own mailbox, over their name.
 *
 * ⚠️ ASSERTED IN BOTH COLUMN ORDERS. Testing one order proves nothing: the old
 * "first header wins" rule passes whichever order happens to put the right
 * column on the left, which is exactly how this survived unnoticed.
 */
describe("which column Eva takes the money from", () => {
  const OUTSTANDING_BEATS_TOTAL: ReadonlyArray<readonly [string, string, string]> = [
    ["Xero", "Total", "InvoiceAmountDue"],
    ["Sage", "Gross Amount", "Outstanding"],
    ["Zoho Books", "Total", "Balance"],
    ["QuickBooks", "Amount", "Open Balance"],
    ["FreeAgent", "Total Value", "Due Value"],
    ["the sample invoices", "Invoice total", "Amount outstanding"],
  ];

  for (const [pkg, total, outstanding] of OUTSTANDING_BEATS_TOTAL) {
    it(`takes what is still owed, not the invoice total (${pkg})`, () => {
      expect(autoMapHeaders([total, outstanding]), "outstanding lost when it came second").toEqual({
        [outstanding]: "amount",
      });
      expect(autoMapHeaders([outstanding, total]), "outstanding lost when it came first").toEqual({
        [outstanding]: "amount",
      });
    });
  }

  it("still takes the total when that is the only figure in the file", () => {
    expect(autoMapHeaders(["Invoice Number", "Total", "Due Date"])).toEqual({
      "Invoice Number": "invoiceNumber",
      Total: "amount",
      "Due Date": "dueDate",
    });
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL. A net figure excludes VAT, so reading one as
   * the debt under-bills by a fifth on every standard-rated UK invoice. These
   * headings are deliberately absent from the alias table and this is what
   * says so — without it, "we chose not to support net" is a claim in a
   * comment rather than a checked fact.
   */
  it("refuses the figures that are not the debt", () => {
    for (const heading of ["Net", "Net Amount", "Net Value", "Subtotal", "VAT", "Tax Amount"]) {
      expect(autoMapHeaders([heading]), `${heading} was read as money`).toEqual({});
    }
  });
});

/**
 * The number Voice Credit Control will dial (founder, 2026-08-27). The email
 * product never reads it — it is collected here because the uploaded book is
 * the only place it exists.
 */
describe("the phone number, for the product next door", () => {
  it("reads the headings a person actually writes", () => {
    for (const heading of [
      "Phone",
      "Phone Number",
      "Telephone",
      "Tel",
      "Mobile",
      "Contact Number",
    ]) {
      expect(autoMapHeaders([heading]), `${heading} was dropped`).toEqual({
        [heading]: "customerPhone",
      });
    }
  });

  it("keeps a named contact's number apart from the client's", () => {
    expect(autoMapHeaders(["Phone", "Contact Phone"])).toEqual({
      Phone: "customerPhone",
      "Contact Phone": "contactPhone",
    });
  });
});
