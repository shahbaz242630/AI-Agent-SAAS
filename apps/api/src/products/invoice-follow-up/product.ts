import type { ProductManifest } from "../../platform/registry/product-manifest.js";

/**
 * Invoice Follow-up — chases unpaid invoices by email from the customer's own
 * mailbox. The first product, and until 2026-08-19 the only one, which is why
 * so much of it had leaked into shared folders: `ledger.ts` (customer
 * resolution and draft-invoice creation) sat in `common/` where every product
 * would have inherited it.
 */
export const INVOICE_FOLLOW_UP: ProductManifest = {
  key: "email_credit_controller",
  tables: [
    "invoice",
    "import",
    "importRow",
    "invoiceDocument",
    "reminderSequence",
    "reminderStep",
    "scheduledAction",
    "humanEscalation",
  ],
};
