import { NotFoundException } from "@nestjs/common";
import { DEFAULT_REMINDER_STEPS } from "@eva/types";
import type { TenantTx } from "../../../platform/permissions/permissions.js";
import { writeAuditLog } from "../../../platform/audit/audit-log.js";
import { isSuppressed } from "../../../platform/suppression/suppression.js";
import { todayInTimezone } from "../invoices/invoice-status.js";
import { checkReminderEligibility, type IneligibilityReason } from "./reminder-eligibility.js";
import { resolveRecipient } from "./reminder-recipient.js";
import {
  applyContactSpacing,
  computeInvoiceSchedule,
  type ScheduleStep,
} from "./reminder-scheduler.js";

/**
 * Slice 1.5 tx-level scheduling functions (plan §3) — plain async functions
 * taking a TenantTx, callable inside ANOTHER module's transaction (the
 * common/suppression pattern). Task 5 hooks invoice lifecycle events onto
 * these; the reconcile sweep and the step-config PATCH call them directly.
 *
 * Audit metadata carries counts + entity ids only — NEVER amounts, emails or
 * other personal data (BRD 14). Mutations audit; reads never do.
 */

/** Lazily provisions the org's default sequence from DEFAULT_REMINDER_STEPS
 *  (BRD 4.1). Idempotent per org: existing rows are re-used, and the partial
 *  unique index (one live default per org, migration 0009) makes duplicates
 *  impossible. A concurrent first-touch race CANNOT be recovered here: every
 *  caller runs inside a $transaction, so the loser's unique violation aborts
 *  its transaction (25P02) — the request (or one sweep org, via per-org
 *  failure isolation) fails loudly and self-heals on retry / the next sweep.
 *  That outcome is rare, safe and honest; there is no silent retry path. */
export async function ensureDefaultSequence(tx: TenantTx, organisationId: string) {
  const existing = await tx.reminderSequence.findFirst({
    where: { organisationId, isDefault: true, deletedAt: null },
    include: { steps: { where: { deletedAt: null } } },
  });
  if (existing) return existing;
  return await tx.reminderSequence.create({
    data: {
      organisationId,
      name: "Default reminder sequence",
      isDefault: true,
      steps: {
        create: DEFAULT_REMINDER_STEPS.map((step) => ({
          organisationId,
          key: step.key,
          offsetDays: step.offsetDays,
          actionType: step.actionType,
        })),
      },
    },
    include: { steps: { where: { deletedAt: null } } },
  });
}

export interface ScheduleInput {
  organisationId: string;
  invoiceId: string;
  timezone: string;
  now?: Date;
  /** Null for system actors (the reconcile sweep); a user id otherwise. */
  actorUserId?: string | null;
}

/**
 * Computes and inserts the send-queue rows for one invoice (plan §3).
 * Ineligible invoices (BRD 4.1 exclusions + the permanent suppression list)
 * insert nothing and report the reason. The unique
 * (invoice_id, reminder_step_id, scheduled_date) constraint + skipDuplicates
 * make re-runs idempotent — a retry never throws and never duplicates.
 */
export async function scheduleInvoiceReminders(
  tx: TenantTx,
  input: ScheduleInput,
): Promise<{ scheduled: number; skipped: IneligibilityReason | null }> {
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, deletedAt: null },
    /* The CLIENT too, since 2026-08-27 — it is the fallback recipient when
       there is no usable contact (`reminder-recipient.ts`). */
    include: { contact: true, customer: { select: { id: true, email: true } } },
  });
  if (!invoice) throw new NotFoundException("Invoice not found");

  const parties = { contact: invoice.contact, customer: invoice.customer };
  /**
   * ⚠️ SUPPRESSION IS CHECKED AGAINST THE ADDRESS EVA WILL USE, which is not
   * always the contact's. Asking about `contact.email` on a client-fallback
   * invoice asks about an address nobody is going to be written to, and answers
   * "not suppressed" — so a client who had asked never to be emailed again
   * would have been scheduled a full sequence.
   */
  const recipient = resolveRecipient(parties);
  const suppressed = recipient
    ? await isSuppressed(tx, input.organisationId, "email", recipient.email)
    : false;
  const eligibility = checkReminderEligibility({
    invoiceStatus: invoice.status,
    ...parties,
    suppressed,
  });
  if (!eligibility.eligible) return { scheduled: 0, skipped: eligibility.reason };

  /**
   * Serialises concurrent scheduling for the same RECIPIENT (transaction-scoped
   * advisory lock) so the BRD 4.1 3-day spacing invariant holds when two
   * invoices for one person are scheduled at once — the second transaction
   * reads the first's committed occupied dates (whole-branch review finding).
   *
   * 🚨 KEYED ON `spacingKey`, NOT `contact.id`, SINCE THE CLIENT FALLBACK
   * LANDED. There is no contact id on that path at all. Left as it was, this
   * line would have locked on `undefined` for exactly the invoices the fallback
   * made chaseable — so the spacing rule would have quietly stopped holding for
   * the customers this change was written to serve, and a client with four
   * overdue invoices could have been sent four emails on one morning.
   */
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${recipient!.spacingKey}))`;

  const sequence = await ensureDefaultSequence(tx, input.organisationId);
  const steps: ScheduleStep[] = sequence.steps.map((step) => ({
    id: step.id,
    key: step.key as ScheduleStep["key"],
    offsetDays: step.offsetDays,
    actionType: step.actionType as ScheduleStep["actionType"],
    enabled: step.enabled,
  }));
  const today = todayInTimezone(input.timezone, input.now);
  const candidates = computeInvoiceSchedule({
    invoiceId: invoice.id,
    dueDate: invoice.dueDate,
    steps,
    today,
  });

  /**
   * BRD 4.1: minimum 3 days between reminders to the same RECIPIENT — dates
   * already occupied by their other invoices (pending/ready only, excluding the
   * rows this call replaces) push candidates forward. Only recipient-facing
   * (email) rows occupy dates (founder ruling 2026-07-27 — internal escalations
   * neither defer nor block).
   *
   * ⚠️ THE CLIENT-FALLBACK ARM IS DELIBERATELY BROADER THAN IT NEEDS TO BE. It
   * counts every live email slot for that CLIENT, including ones addressed to a
   * named contact who is not this recipient. Expressing "the client's other
   * invoices that ALSO fall back" in SQL means reproducing the resolver's rules
   * in a `where` clause, and a second copy of those rules is exactly the drift
   * this refactor removed.
   *
   * The error is one-directional and the safe direction: over-counting DEFERS a
   * reminder by a few days, under-counting SENDS two in a morning. Spacing is a
   * politeness rule about not hounding people, so being slightly too polite
   * costs nothing a customer would complain about.
   */
  const occupied = (
    await tx.scheduledAction.findMany({
      where: {
        status: { in: ["pending", "ready"] },
        actionType: "email",
        invoiceId: { not: invoice.id },
        invoice:
          recipient!.via === "contact"
            ? { contactId: invoice.contact!.id }
            : { customerId: invoice.customerId },
      },
      select: { scheduledDate: true },
    })
  ).map((row) => row.scheduledDate);
  const spaced = applyContactSpacing(candidates, occupied, { invoiceId: invoice.id, today });
  if (spaced.length === 0) return { scheduled: 0, skipped: null };

  // Always insert FRESH rows (founder ruling 2026-07-26): cancelled is
  // terminal — a cancelled slot is simply re-filled (the partial unique index
  // of migration 0011 covers live rows only). skipDuplicates against live
  // slots keeps genuine retries idempotent (BRD 4.1) — a re-run never throws
  // and never duplicates; live rows (pending/ready/claimed/sent/…) are NEVER
  // touched.
  const result = await tx.scheduledAction.createMany({
    data: spaced.map((action) => ({
      organisationId: input.organisationId,
      invoiceId: invoice.id,
      reminderStepId: action.reminderStepId,
      actionType: action.actionType,
      scheduledDate: action.scheduledDate,
      status: action.status,
      idempotencyKey: action.idempotencyKey,
      createdBy: input.actorUserId ?? null,
    })),
    skipDuplicates: true,
  });
  if (result.count > 0) {
    await writeAuditLog(tx, {
      organisationId: input.organisationId,
      actorUserId: input.actorUserId ?? null,
      action: "reminder_action.scheduled",
      entityType: "invoice",
      entityId: invoice.id,
      metadata: { scheduledCount: result.count },
    });
  }
  return { scheduled: result.count, skipped: null };
}

/** Cancels the invoice's live queue rows (pending/ready → cancelled). */
export async function cancelInvoiceReminders(
  tx: TenantTx,
  input: {
    organisationId: string;
    invoiceId: string;
    reason: string;
    actorUserId?: string | null;
  },
): Promise<number> {
  const result = await tx.scheduledAction.updateMany({
    where: { invoiceId: input.invoiceId, status: { in: ["pending", "ready"] } },
    data: { status: "cancelled" },
  });
  if (result.count > 0) {
    await writeAuditLog(tx, {
      organisationId: input.organisationId,
      actorUserId: input.actorUserId ?? null,
      action: "reminder_action.cancelled",
      entityType: "invoice",
      entityId: input.invoiceId,
      metadata: { cancelledCount: result.count, reason: input.reason },
    });
  }
  return result.count;
}

/** Cancel + reschedule inside the caller's transaction (plan §7.5). */
export async function recomputeInvoiceReminders(
  tx: TenantTx,
  input: ScheduleInput,
): Promise<{ scheduled: number }> {
  await cancelInvoiceReminders(tx, { ...input, reason: "recompute" });
  const { scheduled } = await scheduleInvoiceReminders(tx, input);
  return { scheduled };
}
