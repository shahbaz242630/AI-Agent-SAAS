import { ConflictException } from "@nestjs/common";
import type { InvoiceStoredStatus } from "@eva/types";
import type { TenantTx } from "../../common/permissions/permissions.js";

/**
 * THE invoice state machine (BRD 4.1 hard rule): transitionInvoiceStatus is
 * the ONLY code path that may change invoices.status. Legal Slice 1.2
 * transitions (plan §3): Draft→Active, Draft→Cancelled, Active→Paused,
 * Paused→Active, Active→Cancelled, Paused→Cancelled — exposed as the four
 * actions below, each pinned to its legal source states so e.g. `resume`
 * can never activate a Draft. Outcome statuses (promise_to_pay …
 * written_off) have no API path until slice 1.8 (plan §7.3), so they are
 * terminal here. due_soon/due_today/overdue are computed at read time
 * (invoice-status.ts) and never pass through here.
 */
export type InvoiceAction = "activate" | "pause" | "resume" | "cancel";

const ACTIONS: Readonly<
  Record<InvoiceAction, { from: readonly InvoiceStoredStatus[]; to: InvoiceStoredStatus }>
> = {
  activate: { from: ["draft"], to: "active" },
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  cancel: { from: ["draft", "active", "paused"], to: "cancelled" },
};

/**
 * The single status-write path. Throws 409 when `action` is not legal from
 * the invoice's current status. Returns the new stored status so callers can
 * audit-log the from/to (BRD 15).
 */
export async function transitionInvoiceStatus(
  tx: TenantTx,
  invoiceId: string,
  currentStatus: string,
  action: InvoiceAction,
): Promise<InvoiceStoredStatus> {
  const spec = ACTIONS[action];
  if (!spec.from.includes(currentStatus as InvoiceStoredStatus)) {
    throw new ConflictException(`Invoice cannot '${action}' from status '${currentStatus}'`);
  }
  await tx.invoice.update({ where: { id: invoiceId }, data: { status: spec.to } });
  return spec.to;
}
