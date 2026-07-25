import type { ImportCanonicalField } from "@eva/validation";

/**
 * Header auto-mapping (plan §3): when the client sends no `mapping` form
 * field, file headers are matched to canonical fields case-insensitively
 * after normalising (lowercase, alphanumerics only — e.g. "Invoice Number"
 * → invoiceNumber). The resolved mapping is echoed in the upload response.
 * Unmapped required canonical fields surface as per-row errors at staging.
 */

const HEADER_ALIASES: ReadonlyArray<readonly [ImportCanonicalField, readonly string[]]> = [
  ["invoiceNumber", ["invoicenumber", "invoiceno", "invno", "invnumber", "invoice", "invoiceref"]],
  ["amount", ["amount", "total", "value", "amountdue", "totaldue", "invoiceamount", "gross"]],
  ["currency", ["currency", "ccy", "currencycode"]],
  ["issueDate", ["issuedate", "invoicedate", "date", "issued"]],
  ["dueDate", ["duedate", "due", "paymentdue", "datepaymentdue"]],
  [
    "customerReference",
    [
      "customerreference",
      "customerref",
      "accountreference",
      "accountref",
      "accountnumber",
      "account",
      "reference",
      "ref",
    ],
  ],
  [
    "customerName",
    ["customername", "customer", "clientname", "client", "companyname", "company", "accountname"],
  ],
  ["customerEmail", ["customeremail", "email", "emailaddress", "customeremailaddress"]],
  ["contactName", ["contactname", "contact", "attention", "attn"]],
  ["contactEmail", ["contactemail", "contactemailaddress"]],
];

function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps file headers to canonical fields; the first header claiming a field wins. */
export function autoMapHeaders(headers: string[]): Record<string, ImportCanonicalField> {
  const aliasToField = new Map<string, ImportCanonicalField>();
  for (const [field, aliases] of HEADER_ALIASES) {
    for (const alias of aliases) {
      if (!aliasToField.has(alias)) aliasToField.set(alias, field);
    }
  }
  const mapping: Record<string, ImportCanonicalField> = {};
  const claimed = new Set<ImportCanonicalField>();
  for (const header of headers) {
    const field = aliasToField.get(normaliseHeader(header));
    if (field && !claimed.has(field)) {
      mapping[header] = field;
      claimed.add(field);
    }
  }
  return mapping;
}
