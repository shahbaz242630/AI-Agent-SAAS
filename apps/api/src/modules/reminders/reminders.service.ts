import { Injectable, NotFoundException } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import { CHASED_INVOICE_STATUSES } from "@eva/types";
import type {
  ReminderActionType,
  ReminderSequenceDto,
  ReminderStepDto,
  ReminderStepKey,
  ScheduledActionDto,
  ScheduledActionStatus,
} from "@eva/types";
import type { UpdateReminderStepInput } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { todayInTimezone } from "../invoices/invoice-status.js";
import {
  ensureDefaultSequence,
  recomputeInvoiceReminders,
  scheduleInvoiceReminders,
} from "./reminder-actions.js";

const DEFAULT_TIMEZONE = "Europe/London";

/** POST /internal/reminders/reconcile response (plan §7.8). */
export interface ReconcileResult {
  processed: number;
  failed: string[];
}

@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RemindersService.name);
  }

  /** GET .../reminder-sequence — reminders:read. Provisions the default
   *  sequence lazily on first read (plan §3); reads are never audited. */
  async getSequence(authUser: AuthUser, organisationId: string): Promise<ReminderSequenceDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "reminders:read");
      return toSequenceDto(await ensureDefaultSequence(tx, organisationId));
    });
  }

  /** PATCH .../reminder-sequence/steps/:stepId — reminders:write. Persists the
   *  edit, then recomputes every live active invoice org-wide in the SAME
   *  transaction (plan §7.5). The 30s transaction timeout (Prisma default is
   *  5s) covers the org-wide recompute at cloud latency — staging 500'd on
   *  2026-07-27 with just 3 active invoices (api US West ↔ Supabase London). */
  async updateStep(
    authUser: AuthUser,
    organisationId: string,
    stepId: string,
    input: UpdateReminderStepInput,
  ): Promise<ReminderStepDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx) => {
        await requirePermission(tx, organisationId, user.id, "reminders:write");
        const step = await tx.reminderStep.findFirst({ where: { id: stepId, deletedAt: null } });
        if (!step) throw new NotFoundException("Reminder step not found");
        const updated = await tx.reminderStep.update({
          where: { id: step.id },
          data: {
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.offsetDays !== undefined ? { offsetDays: input.offsetDays } : {}),
          },
        });
        await writeAuditLog(tx, {
          organisationId,
          actorUserId: user.id,
          action: "reminder_step.updated",
          entityType: "reminder_step",
          entityId: step.id,
          metadata: {
            changedFields: Object.keys(input).filter(
              (key) => input[key as keyof UpdateReminderStepInput] !== undefined,
            ),
          },
        });
        const timezone = await this.orgTimezone(tx, organisationId);
        // Every CHASED status, not just `active` — a part-paid invoice is still
        // being chased for its balance (slice 1.6c).
        const activeInvoices = await tx.invoice.findMany({
          where: { status: { in: [...CHASED_INVOICE_STATUSES] }, deletedAt: null },
          select: { id: true },
        });
        for (const invoice of activeInvoices) {
          await recomputeInvoiceReminders(tx, {
            organisationId,
            invoiceId: invoice.id,
            timezone,
            actorUserId: user.id,
          });
        }
        return toStepDto(updated);
      },
      { timeout: 30_000 },
    );
  }

  /** GET .../invoices/:invoiceId/scheduled-actions — reminders:read. The
   *  invoice must belong to the org + customer, else 404 (BRD 15). */
  async listScheduledActions(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<ScheduledActionDto[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "reminders:read");
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, customerId, deletedAt: null },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");
      const actions = await tx.scheduledAction.findMany({
        where: { invoiceId },
        orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }],
      });
      return actions.map(toActionDto);
    });
  }

  /**
   * The daily reconcile sweep (plan §7.8). Organisations are enumerated via
   * the owner-owned SECURITY DEFINER list_active_organisations() (migration
   * 0010 — the only controlled cross-tenant path); each org is then processed
   * in its OWN tenant transaction under per-org RLS. One org's failure is
   * logged and collected — the sweep continues (failure isolation) and still
   * answers 200. Idempotent end-to-end: the unique constraints and the
   * escalation dedup make repeats no-ops.
   */
  async reconcile(): Promise<ReconcileResult> {
    const rows = await this.prisma.db.$queryRaw<
      { list_active_organisations: string }[]
    >`SELECT * FROM list_active_organisations()`;
    const failed: string[] = [];
    let processed = 0;
    for (const row of rows) {
      try {
        await this.reconcileOrganisation(row.list_active_organisations);
        processed += 1;
      } catch (error) {
        this.logger.error(
          { err: error, organisationId: row.list_active_organisations },
          "reminder reconcile failed for organisation",
        );
        failed.push(row.list_active_organisations);
      }
    }
    return { processed, failed };
  }

  private async reconcileOrganisation(organisationId: string): Promise<void> {
    // System context: there is no acting user, so only app.current_org is
    // declared — the same set_config(..., true) (SET LOCAL) mechanism
    // withTenant uses, pool-safe and scoped to this transaction.
    await this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      const tx = rawTx as unknown as TenantTx;

      const timezone = await this.orgTimezone(tx, organisationId);
      const today = todayInTimezone(timezone);

      // (a) Due rows become claimable by the 1.7 sender.
      await tx.scheduledAction.updateMany({
        where: { status: "pending", scheduledDate: { lte: today } },
        data: { status: "ready" },
      });

      // (b) Final-reminder escalation hands over to a human (plan §3). The
      // unique scheduled_action_id dedups repeats across sweep runs.
      // Concurrency assumption: a SINGLE daily reconcile schedule. Two
      // concurrent runs would collide on that unique key here, roll back THIS
      // org's transaction into `failed` (per-org failure isolation below) and
      // self-heal on the next run — never a duplicate escalation.
      const escalationActions = await tx.scheduledAction.findMany({
        where: { status: "ready", actionType: "internal_escalation", humanEscalation: null },
      });
      for (const action of escalationActions) {
        const escalation = await tx.humanEscalation.create({
          data: {
            organisationId,
            invoiceId: action.invoiceId,
            scheduledActionId: action.id,
            reason: "final_reminder_escalation",
          },
        });
        await writeAuditLog(tx, {
          organisationId,
          actorUserId: null,
          action: "escalation.created",
          entityType: "human_escalation",
          entityId: escalation.id,
          metadata: { invoiceId: action.invoiceId, scheduledActionId: action.id },
        });
      }

      // (c) Backfill: live CHASED invoices with zero non-cancelled actions
      // (created before the 1.5 hooks, or by paths that bypass them). Includes
      // part-paid invoices — the balance is still owed (slice 1.6c).
      const unscheduled = await tx.invoice.findMany({
        where: {
          status: { in: [...CHASED_INVOICE_STATUSES] },
          deletedAt: null,
          scheduledActions: { none: { status: { not: "cancelled" } } },
        },
        select: { id: true },
      });
      for (const invoice of unscheduled) {
        await scheduleInvoiceReminders(tx, { organisationId, invoiceId: invoice.id, timezone });
      }
    });
  }

  /** The org's business timezone (BRD 18.1); default Europe/London. */
  private async orgTimezone(tx: TenantTx, organisationId: string): Promise<string> {
    const settings = await tx.organisationSettings.findUnique({ where: { organisationId } });
    return settings?.timezone ?? DEFAULT_TIMEZONE;
  }
}

type SequenceWithSteps = Awaited<ReturnType<typeof ensureDefaultSequence>>;

function toSequenceDto(sequence: SequenceWithSteps): ReminderSequenceDto {
  return {
    id: sequence.id,
    name: sequence.name,
    isDefault: sequence.isDefault,
    steps: sequence.steps.map(toStepDto),
  };
}

function toStepDto(step: {
  id: string;
  key: string;
  offsetDays: number;
  actionType: string;
  enabled: boolean;
}): ReminderStepDto {
  return {
    id: step.id,
    key: step.key as ReminderStepKey,
    offsetDays: step.offsetDays,
    actionType: step.actionType as ReminderActionType,
    enabled: step.enabled,
  };
}

function toActionDto(action: {
  id: string;
  invoiceId: string;
  reminderStepId: string;
  actionType: string;
  scheduledDate: Date;
  status: string;
  idempotencyKey: string;
}): ScheduledActionDto {
  return {
    id: action.id,
    invoiceId: action.invoiceId,
    reminderStepId: action.reminderStepId,
    actionType: action.actionType as ReminderActionType,
    // @db.Date is UTC midnight — slice is the org-local calendar day.
    scheduledDate: action.scheduledDate.toISOString().slice(0, 10),
    status: action.status as ScheduledActionStatus,
    idempotencyKey: action.idempotencyKey,
  };
}
