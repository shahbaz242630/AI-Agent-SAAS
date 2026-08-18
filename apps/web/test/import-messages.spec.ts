import { describe, expect, it } from "vitest";
import { autoMapHeaders } from "@eva/validation";
import {
  FIELD_LABELS,
  importConfirmLabel,
  importConfirmedLine,
  importFieldLabel,
  importReadLine,
  importRowStatusLabel,
  isImportableRowStatus,
} from "../src/lib/import-messages";

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
});
