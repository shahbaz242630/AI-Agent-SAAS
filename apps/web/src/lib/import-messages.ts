/**
 * What an upload is doing, in words (slice 1.6c — the founder's upload flow).
 *
 * A pure module in `lib` for the `mailbox-messages.ts` reason: every line has a
 * singular, a plural or a zero branch, and this project has shipped
 * "lowering to 1 seats" through a fully green gate.
 */

/**
 * Must match `MAX_UPLOAD_BYTES` in the api's `import-parser.ts`.
 *
 * ⚠️ IT LIVES HERE RATHER THAN BESIDE THE SERVER ACTION THAT USES IT, and that
 * is not tidiness. A `"use server"` file may only export ASYNC FUNCTIONS —
 * exporting this constant from `actions.ts` produced a runtime 500 ("can only
 * export async functions, found number") on the first real upload, having
 * passed both typecheck and lint. Neither tool knows the rule.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The columns the importer understands, as `IMPORT_CANONICAL_FIELDS` names them. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  invoiceNumber: "Invoice number",
  amount: "Amount",
  currency: "Currency",
  issueDate: "Invoice date",
  dueDate: "Due date",
  customerReference: "Your client reference",
  customerName: "Client name",
  customerEmail: "Client email",
  contactName: "Contact name",
  contactEmail: "Contact email",
};

export function importFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * What each staged row's status means to a person.
 *
 * ⚠️ NOT THE API'S WORDS. "suppressed" means the contact has asked never to be
 * emailed, which is a permanent, cross-channel decision — a customer reading
 * "suppressed" would guess almost anything.
 */
const ROW_STATUS_LABELS: Readonly<Record<string, string>> = {
  valid: "Ready",
  invalid: "Needs fixing",
  duplicate: "Already on file",
  suppressed: "Do not contact",
  imported: "Imported",
  skipped: "Skipped",
};

export function importRowStatusLabel(status: string): string {
  return ROW_STATUS_LABELS[status] ?? status;
}

/** Rows that will actually become invoices are the ones worth emphasising. */
export function isImportableRowStatus(status: string): boolean {
  return status === "valid";
}

/**
 * What the file turned out to contain.
 *
 * ⚠️ EVERY ROW IS ACCOUNTED FOR. A count of what will import, with nothing said
 * about the rest, is how somebody uploads two hundred rows, sees "180 ready",
 * confirms, and never learns what happened to the other twenty.
 */
export function importReadLine(counts: {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  suppressedRows: number;
}): string {
  if (counts.totalRows === 0) {
    return "That file had no rows in it.";
  }
  const rows = counts.totalRows === 1 ? "1 row" : `${counts.totalRows} rows`;
  const parts: string[] = [`${counts.validRows} ready to import`];
  if (counts.duplicateRows > 0) parts.push(`${counts.duplicateRows} already on file`);
  if (counts.suppressedRows > 0) parts.push(`${counts.suppressedRows} marked do not contact`);
  if (counts.invalidRows > 0) {
    // ⚠️ "1 that NEEDS fixing", not "1 that need fixing". Shipped as the latter
    // and read on screen — the same disagreement as "lowering to 1 seats",
    // which this project has now produced three times. The test above only
    // covered the plural, which is how it got through.
    parts.push(
      counts.invalidRows === 1 ? "1 that needs fixing" : `${counts.invalidRows} that need fixing`,
    );
  }
  return `${rows} read: ${parts.join(", ")}.`;
}

/** The confirm button, saying exactly what it will do. */
export function importConfirmLabel(validRows: number): string {
  if (validRows === 0) return "Nothing to import";
  return validRows === 1 ? "Import 1 invoice" : `Import ${validRows} invoices`;
}

/**
 * What happened after confirming.
 *
 * ⚠️ IT MUST SAY THEY ARE DRAFTS. The importer creates DRAFT invoices, so
 * nothing is chased until somebody starts them — which is the safe behaviour
 * and completely invisible unless it is said. Somebody who uploads two hundred
 * invoices and assumes Eva is now chasing them would find out weeks later.
 */
export function importConfirmedLine(createdRows: number, skipped: number): string {
  if (createdRows === 0) {
    return "Nothing was imported — no rows were ready.";
  }
  const invoices = createdRows === 1 ? "1 invoice" : `${createdRows} invoices`;
  const base = `${invoices} added as drafts. Nothing is being chased yet — start them when you have checked them.`;
  if (skipped === 0) return base;
  const left = skipped === 1 ? "1 row was" : `${skipped} rows were`;
  return `${base} ${left} left out; they are listed above.`;
}

/**
 * The rules a file has to meet, said before it is chosen rather than after it
 * is refused.
 */
export function importFileRulesLine(maxBytes: number): string {
  return `CSV or Excel (.xlsx), up to ${Math.round(maxBytes / (1024 * 1024))} MB. The first row must be your column headings.`;
}
