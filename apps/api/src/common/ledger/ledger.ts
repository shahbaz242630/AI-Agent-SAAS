import type { ImportCanonicalField } from "@eva/validation";
import type { TenantTx } from "../permissions/permissions.js";
import { todayInTimezone } from "../../modules/invoices/invoice-status.js";

/**
 * Shared ledger write helpers (Slice 1.4 plan §3): customer resolution and
 * Draft-invoice creation as used by BOTH the 1.3 CSV/Excel import and the
 * 1.4 PDF invoice-document confirm. Extracted from imports.service.ts with
 * no behaviour change — one code path, identical semantics everywhere:
 * resolve by reference → case-insensitive exact name → create (ambiguous is
 * an error, never a guess); imported invoices always land as DRAFT (BRD 4.1
 * hard rule — activation stays the 1.2 per-invoice human action).
 */

/** Canonical invoice-adjacent fields as raw strings (import row, extraction, or
 *  a human-reviewed confirm body projected onto the same shape). */
export type CanonicalRow = Partial<Record<ImportCanonicalField, string>>;

/** Semantic invoice values parsed from canonical raw values (BRD 10 minor units). */
export interface ParsedInvoiceValues {
  invoiceNumber: string;
  amountMinorUnits: number;
  currency: string;
  issueDate?: Date;
  dueDate: Date;
}

export interface CustomerMatch {
  id: string;
  name: string;
  reference: string | null;
}

export type CustomerResolution =
  | { kind: "matched"; customerId: string }
  | { kind: "ambiguous"; matches: number }
  | { kind: "create" };

/** Live (not soft-deleted) customers of the active tenant, for resolution. */
export async function listLiveCustomers(tx: TenantTx): Promise<CustomerMatch[]> {
  return tx.customer.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, reference: true },
  });
}

/** Live invoice numbers only — a soft-deleted number is reusable (0006 index). */
export async function listLiveInvoiceNumbers(tx: TenantTx): Promise<Set<string>> {
  const invoices = await tx.invoice.findMany({
    where: { deletedAt: null },
    select: { invoiceNumber: true },
  });
  return new Set(invoices.map((invoice) => invoice.invoiceNumber));
}

/**
 * Customer pre-resolution (1.3 plan §7.2): live customer by reference, else by
 * case-insensitive exact name; multiple matches are errors, never guesses.
 */
export function resolveCustomer(
  canonical: CanonicalRow,
  customers: CustomerMatch[],
): CustomerResolution {
  if (canonical.customerReference !== undefined) {
    const matches = customers.filter((c) => c.reference === canonical.customerReference);
    if (matches.length === 1) return { kind: "matched", customerId: matches[0]!.id };
    if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
  }
  if (canonical.customerName !== undefined) {
    const wanted = canonical.customerName.toLowerCase();
    const matches = customers.filter((c) => c.name.toLowerCase() === wanted);
    if (matches.length === 1) return { kind: "matched", customerId: matches[0]!.id };
    if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
  }
  return { kind: "create" };
}

/** Auto-creates an unmatched customer (1.3 plan §7.2); never updates existing rows. */
export async function createCustomerFromCanonical(
  tx: TenantTx,
  organisationId: string,
  userId: string,
  canonical: CanonicalRow,
) {
  return tx.customer.create({
    data: {
      organisationId,
      name: (canonical.customerName ?? canonical.customerReference)!,
      email: canonical.customerEmail?.toLowerCase() ?? null,
      reference: canonical.customerReference ?? null,
      createdBy: userId,
    },
  });
}

/** Creates a contact when contact fields are present, reusing a live contact
 *  with the same normalised email on that customer (never duplicates). */
export async function resolveOrCreateContact(
  tx: TenantTx,
  organisationId: string,
  userId: string,
  customerId: string,
  canonical: CanonicalRow,
): Promise<string | null> {
  if (canonical.contactName === undefined && canonical.contactEmail === undefined) return null;
  const email = canonical.contactEmail?.toLowerCase() ?? null;
  if (email !== null) {
    const existing = await tx.contact.findFirst({
      where: { customerId, deletedAt: null, email },
    });
    if (existing) return existing.id;
  }
  const contact = await tx.contact.create({
    data: {
      organisationId,
      customerId,
      name: canonical.contactName ?? email!,
      email,
      createdBy: userId,
    },
  });
  return contact.id;
}

/** Creates a DRAFT invoice (1.3 plan §7.7) — the same creation semantics as
 *  1.2: integer minor units, currency, issueDate defaulting to the creation
 *  day in the org timezone (BRD 18.1). */
export async function createDraftInvoice(
  tx: TenantTx,
  organisationId: string,
  userId: string,
  timezone: string,
  input: { customerId: string; contactId: string | null; values: ParsedInvoiceValues },
) {
  return tx.invoice.create({
    data: {
      organisationId,
      customerId: input.customerId,
      contactId: input.contactId,
      invoiceNumber: input.values.invoiceNumber,
      amountMinorUnits: input.values.amountMinorUnits,
      currency: input.values.currency,
      issueDate: input.values.issueDate ?? todayInTimezone(timezone),
      dueDate: input.values.dueDate,
      status: "draft",
      createdBy: userId,
    },
  });
}
