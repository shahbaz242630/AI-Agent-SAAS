import { ConflictException } from "@nestjs/common";
import type { InvoiceDocumentStatus } from "@eva/types";
import type { TenantTx } from "../../common/permissions/permissions.js";

/**
 * THE invoice-document status machine (the 1.2/1.3 pattern):
 * transitionInvoiceDocumentStatus is the ONLY code path that may change
 * invoice_documents.status. Extraction is synchronous (plan §7.1): a fresh
 * upload lands in `extracted` or `failed`; re-extraction is allowed from both
 * (the retry endpoint); confirm is allowed from `extracted` AND `failed` —
 * the §7.7 hybrid ruling (total extraction failure → full manual entry).
 * Cancel is NOT a status: it is a soft delete (the 0008 CHECK has no
 * 'cancelled' status) handled by the service.
 */
export type InvoiceDocumentAction = "extracted" | "failed" | "confirm";

const ACTIONS: Readonly<
  Record<
    InvoiceDocumentAction,
    { from: readonly InvoiceDocumentStatus[]; to: InvoiceDocumentStatus }
  >
> = {
  extracted: { from: ["uploaded", "extracted", "failed"], to: "extracted" },
  failed: { from: ["uploaded", "extracted", "failed"], to: "failed" },
  confirm: { from: ["extracted", "failed"], to: "confirmed" },
};

/**
 * The single status-write path. Throws 409 when `action` is not legal from
 * the document's current status. Returns the new stored status.
 */
export async function transitionInvoiceDocumentStatus(
  tx: TenantTx,
  documentId: string,
  currentStatus: string,
  action: InvoiceDocumentAction,
): Promise<InvoiceDocumentStatus> {
  const spec = ACTIONS[action];
  if (!spec.from.includes(currentStatus as InvoiceDocumentStatus)) {
    throw new ConflictException(
      `Invoice document cannot '${action}' from status '${currentStatus}'`,
    );
  }
  await tx.invoiceDocument.update({ where: { id: documentId }, data: { status: spec.to } });
  return spec.to;
}
