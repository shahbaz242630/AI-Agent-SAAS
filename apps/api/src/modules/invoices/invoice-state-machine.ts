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
/** The four a user can ask for directly, each with its own endpoint. */
export type InvoiceLifecycleAction = "activate" | "pause" | "resume" | "cancel";

/**
 * Slice 1.6c, task 5 — the two transitions recording a payment adds.
 *
 * ⚠️ DELIBERATELY A SEPARATE TYPE, so they cannot reach `transition()` and get
 * their own endpoint by accident. `POST :invoiceId/payments` takes an amount
 * and the SERVICE decides which applies from the resulting balance. There is no
 * "mark as paid" in this API: the only route to `paid` is money that clears the
 * balance, written in the same transaction as the status.
 */
export type InvoicePaymentAction = "pay_in_part" | "pay_in_full";

export type InvoiceAction = InvoiceLifecycleAction | InvoicePaymentAction;

const ACTIONS: Readonly<
  Record<InvoiceAction, { from: readonly InvoiceStoredStatus[]; to: InvoiceStoredStatus }>
> = {
  activate: { from: ["draft"], to: "active" },
  // `partially_paid` is a chased status, so it pauses and cancels like `active`.
  pause: { from: ["active", "partially_paid"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  cancel: { from: ["draft", "active", "paused", "partially_paid"], to: "cancelled" },
  /**
   * A payment that does not clear the balance. NOT legal from `paused`: the
   * payment is still recorded there, but the status is deliberately left alone
   * — somebody paused that chase on purpose (a query, a dispute), and taking a
   * part payment is not them saying to start it up again. The payment service
   * skips the transition entirely in that case.
   */
  pay_in_part: { from: ["active", "partially_paid"], to: "partially_paid" },
  /**
   * A payment that clears it. Legal from `paused` too, because "they have paid
   * in full" is true whatever the chase was doing, and leaving it Paused would
   * misdescribe a settled invoice.
   *
   * ⚠️ NOT legal from `cancelled` — the state machine has no way out of
   * cancelled, and every screen promises that. A payment against a cancelled
   * invoice is refused 409 rather than quietly resurrecting it; see the handoff.
   */
  pay_in_full: { from: ["active", "paused", "partially_paid"], to: "paid" },
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
