/**
 * Sentences the invoice screens put in front of a customer (slice 1.6c).
 *
 * A pure module in `lib` for the same reason as `mailbox-messages.ts`: every
 * one of these has a singular branch, a plural branch, or a zero branch that
 * must not read as a failure — and this project has shipped "lowering to 1
 * seats" and "If you arethe administrator" through a fully green gate. Here
 * they are testable without rendering a page.
 */

/**
 * What this client's invoice list is, in one line.
 *
 * The zero branch says nothing is being CHASED rather than "no invoices found",
 * because an empty list is a normal state for a client who always pays up
 * front, not a search that failed.
 */
export function invoiceCountLine(count: number, clientName: string): string {
  if (count === 0) return `Nothing is being chased for ${clientName}.`;
  const invoices = count === 1 ? "1 invoice" : `${count} invoices`;
  // "What is left, never the total" is the one thing about Eva that a credit
  // controller needs to believe, and this list is the first place they see it.
  return `${invoices} for ${clientName}. Eva chases what is left, never the total.`;
}

/**
 * The empty state.
 *
 * Deliberately not "No results" — there was no query. Nothing has gone wrong
 * and nothing is missing; this client simply has no invoices on file.
 */
export function noInvoicesLine(clientName: string): string {
  return `No invoices for ${clientName} yet.`;
}
