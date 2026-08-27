/**
 * What an upload is doing, in words (slice 1.6c — the founder's upload flow).
 *
 * A pure module in `lib` for the `mailbox-messages.ts` reason: every line has a
 * singular, a plural or a zero branch, and this project has shipped
 * "lowering to 1 seats" through a fully green gate.
 */

/**
 * ⚠️ `MAX_UPLOAD_BYTES` USED TO BE DECLARED HERE, as a second copy of the api's
 * number with a comment asking the reader to keep the two in step. It now comes
 * from `@eva/types` so both sides read one value. Import it from there.
 *
 * What has NOT changed is why it may not live in `actions.ts`: a `"use server"`
 * file may only export ASYNC FUNCTIONS, and exporting a number from one produced
 * a runtime 500 ("can only export async functions, found number") on the first
 * real upload, having passed both typecheck and lint. Neither tool knows the
 * rule. A shared package is a safe home for it; a server-action file is not.
 */

/**
 * The columns the importer understands, as `IMPORT_CANONICAL_FIELDS` names them.
 *
 * ⚠️ EVERY LABEL HERE IS A PROMISE THE MATCHER HAS TO KEEP. This list is
 * printed on the upload screen under "Columns Eva understands", so a person
 * names their spreadsheet column exactly this way and expects it to be read.
 * Two of them — "Client email" and "Your client reference" — were never
 * aliases in `autoMapHeaders`, so both columns were silently dropped from every
 * upload that followed our own advice. Found by uploading one, 2026-08-18.
 *
 * ⚠️ EXPORTED SO `import-messages.spec.ts` CAN HOLD IT AGAINST THE MATCHER,
 * which is the only reason the two can no longer drift. Adding a field here
 * without an alias for its label now fails a test rather than a customer.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  invoiceNumber: "Invoice number",
  /**
   * ⚠️ IT SAYS OUTSTANDING NOW, AND THE WORD IS THE POINT. Founder,
   * 2026-08-27: the figure Eva needs is what is still owed, not what the
   * invoice was for. `Amount` is still read — the matcher keeps every total
   * wording as a fallback — but this list is what a person names their column
   * after, and pointing them at the total is how a part-paid debtor gets
   * chased for money they have already sent.
   */
  amount: "Amount outstanding",
  currency: "Currency",
  issueDate: "Invoice date",
  dueDate: "Due date",
  customerReference: "Your client reference",
  customerName: "Client name",
  customerEmail: "Client email",
  customerPhone: "Client phone",
  contactName: "Contact name",
  contactEmail: "Contact email",
  contactPhone: "Contact phone",
};

/**
 * 🚨 UNDERSTOOD BUT NOT ADVERTISED — the founder's "no need to duplicate".
 *
 * Founder, 2026-08-27, reading the chip list: *"why do we have contact email
 * and client email twice? same for client phone, contact phone? no need to
 * duplicate"*. He was right, and the reason was worse than repetition: the
 * CLIENT's address was read by nothing at all, so of the two that looked alike,
 * the one a small business would naturally fill in did nothing.
 *
 * Eva now falls back to the client's own address (`reminder-recipient.ts`), so
 * the client column is the one that works for everybody and the contact column
 * is the specialisation — worth having for a bigger client with a named person
 * in accounts, not worth putting on a list headed "columns Eva understands"
 * beside its twin.
 *
 * ⚠️ STILL READ, JUST NOT ADVERTISED. A file already using these headings keeps
 * importing exactly as before — `import-messages.spec.ts` asserts that, because
 * "we stopped mentioning it" and "we stopped supporting it" are very different
 * promises to have broken.
 */
const UNDERSTOOD_BUT_NOT_ADVERTISED: readonly string[] = ["contactEmail", "contactPhone"];

/**
 * The columns the upload screen offers as advice, in canonical order.
 *
 * ⚠️ DERIVED, SO IT CANNOT DRIFT — with ONE named exception above rather than a
 * hand-kept list. The screen used to type the field names out a third time,
 * pinned by nothing, which is how "Client email" came to be advertised as a
 * heading the matcher had never heard of (found by uploading a file,
 * 2026-08-18).
 */
export const ADVERTISED_IMPORT_FIELDS: readonly string[] = Object.keys(FIELD_LABELS).filter(
  (field) => !UNDERSTOOD_BUT_NOT_ADVERTISED.includes(field),
);

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
