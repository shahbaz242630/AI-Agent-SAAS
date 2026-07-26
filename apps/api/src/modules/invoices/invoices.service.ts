import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, withTenant } from "@eva/database";
import {
  INVOICE_COMPUTED_STATUSES,
  INVOICE_STORED_STATUSES,
  type InvoiceDisplayStatus,
} from "@eva/types";
import type { CreateInvoiceRequest, UpdateInvoiceRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { deriveDisplayStatus, todayInTimezone } from "./invoice-status.js";
import { transitionInvoiceStatus, type InvoiceAction } from "./invoice-state-machine.js";
import {
  cancelInvoiceReminders,
  recomputeInvoiceReminders,
  scheduleInvoiceReminders,
} from "../reminders/reminder-actions.js";

export interface InvoiceSummary {
  id: string;
  customerId: string;
  contactId: string | null;
  invoiceNumber: string;
  amountMinorUnits: number;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  /** The stored status (one of the nine — plan §7.1). */
  status: string;
  /** Stored status, or due_soon/due_today/overdue derived for Active rows. */
  displayStatus: InvoiceDisplayStatus;
  createdAt: Date;
  updatedAt: Date;
}

type InvoiceRow = Omit<InvoiceSummary, "displayStatus">;

const DEFAULT_TIMEZONE = "Europe/London";

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** Lists a customer's invoices — invoices:read. Filters: status (stored or
   *  computed), contactId. Soft-deleted rows are excluded. */
  async list(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    filters: { status?: string; contactId?: string },
  ): Promise<InvoiceSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:read");
      await this.requireCustomer(tx, customerId);
      const timezone = await this.orgTimezone(tx, organisationId);
      let summaries = (
        await tx.invoice.findMany({
          where: { customerId, deletedAt: null },
          orderBy: [{ dueDate: "asc" }, { invoiceNumber: "asc" }],
        })
      ).map((row) => this.toSummary(row, timezone));
      if (filters.status !== undefined) {
        const status = filters.status;
        const isStored = (INVOICE_STORED_STATUSES as readonly string[]).includes(status);
        const isComputed = (INVOICE_COMPUTED_STATUSES as readonly string[]).includes(status);
        if (!isStored && !isComputed) {
          throw new BadRequestException(`Unknown invoice status filter '${status}'`);
        }
        summaries = summaries.filter((summary) =>
          isComputed ? summary.displayStatus === status : summary.status === status,
        );
      }
      if (filters.contactId !== undefined) {
        summaries = summaries.filter((summary) => summary.contactId === filters.contactId);
      }
      return summaries;
    });
  }

  /** Creates an invoice as Draft (or Active when already sent) — invoices:write. */
  async create(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    input: CreateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      await this.requireCustomer(tx, customerId);
      if (input.contactId !== undefined) {
        await this.requireContactOfCustomer(tx, customerId, input.contactId);
      }
      await this.ensureInvoiceNumberAvailable(tx, organisationId, input.invoiceNumber);
      const timezone = await this.orgTimezone(tx, organisationId);
      const invoice = await this.createRow(tx, {
        organisationId,
        customerId,
        contactId: input.contactId ?? null,
        invoiceNumber: input.invoiceNumber,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        issueDate:
          input.issueDate !== undefined ? new Date(input.issueDate) : todayInTimezone(timezone),
        dueDate: new Date(input.dueDate),
        status: input.status,
        createdBy: user.id,
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.created",
        entityType: "invoice",
        entityId: invoice.id,
        metadata: { customerId, invoiceNumber: invoice.invoiceNumber, status: invoice.status },
      });
      return this.toSummary(invoice, timezone);
    });
  }

  /** Reads one invoice — invoices:read. Cross-tenant/deleted ids are 404. */
  async getById(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:read");
      const timezone = await this.orgTimezone(tx, organisationId);
      return this.toSummary(await this.findOrThrow(tx, customerId, invoiceId), timezone);
    });
  }

  /** Updates a DRAFT invoice — invoices:write. Never touches status (BRD 4.1). */
  async update(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
    input: UpdateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);
      this.requireDraft(existing, "updated");
      if (input.contactId !== undefined) {
        await this.requireContactOfCustomer(tx, customerId, input.contactId);
      }
      if (input.invoiceNumber !== undefined && input.invoiceNumber !== existing.invoiceNumber) {
        await this.ensureInvoiceNumberAvailable(tx, organisationId, input.invoiceNumber, invoiceId);
      }
      const invoice = await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          ...(input.invoiceNumber !== undefined ? { invoiceNumber: input.invoiceNumber } : {}),
          ...(input.amountMinorUnits !== undefined
            ? { amountMinorUnits: input.amountMinorUnits }
            : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.issueDate !== undefined ? { issueDate: new Date(input.issueDate) } : {}),
          ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
          ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.updated",
        entityType: "invoice",
        entityId: invoice.id,
        metadata: {
          changedFields: Object.keys(input).filter(
            (key) => input[key as keyof UpdateInvoiceRequest] !== undefined,
          ),
        },
      });
      const timezone = await this.orgTimezone(tx, organisationId);
      return this.toSummary(invoice, timezone);
    });
  }

  /** Soft-deletes a DRAFT invoice (BRD 10) — invoices:write. Audit-logged. */
  async remove(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);
      this.requireDraft(existing, "deleted");
      await tx.invoice.update({ where: { id: invoiceId }, data: { deletedAt: new Date() } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.deleted",
        entityType: "invoice",
        entityId: invoiceId,
        metadata: { customerId },
      });
    });
  }

  /**
   * State-machine actions — invoices:write. activate: Draft→Active;
   * pause: Active→Paused; resume: Paused→Active; cancel: Draft/Active/
   * Paused→Cancelled. Everything else is rejected by the state machine (409).
   * The Slice 1.5 reminder schedule is kept in lockstep INSIDE the same
   * transaction (plan §3 recompute triggers; BRD 4.1) — a scheduling failure
   * rolls the status change back with it.
   */
  async transition(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
    action: InvoiceAction,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);
      const to = await transitionInvoiceStatus(tx, invoiceId, existing.status, action);
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.status_changed",
        entityType: "invoice",
        entityId: invoiceId,
        metadata: { from: existing.status, to },
      });
      const timezone = await this.orgTimezone(tx, organisationId);
      await this.syncReminderSchedule(tx, organisationId, invoiceId, action, timezone, user.id);
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      return this.toSummary(invoice, timezone);
    });
  }

  /**
   * Slice 1.5 (plan §3): the reminder-schedule side effect of each legal
   * transition. activate schedules; pause/cancel cancel every live row;
   * resume recomputes from today (cancel + fresh rows — migration 0011 keeps
   * cancelled rows as history). Draft invoices carry no schedule, so a cancel
   * from Draft is a no-op. The 1.2 PATCH is Draft-only, so no path can edit
   * an Active invoice's due_date and there is no due-date recompute hook.
   */
  private async syncReminderSchedule(
    tx: TenantTx,
    organisationId: string,
    invoiceId: string,
    action: InvoiceAction,
    timezone: string,
    actorUserId: string,
  ): Promise<void> {
    switch (action) {
      case "activate":
        await scheduleInvoiceReminders(tx, { organisationId, invoiceId, timezone, actorUserId });
        break;
      case "resume":
        await recomputeInvoiceReminders(tx, { organisationId, invoiceId, timezone, actorUserId });
        break;
      case "pause":
        await cancelInvoiceReminders(tx, {
          organisationId,
          invoiceId,
          reason: "invoice_paused",
          actorUserId,
        });
        break;
      case "cancel":
        await cancelInvoiceReminders(tx, {
          organisationId,
          invoiceId,
          reason: "invoice_cancelled",
          actorUserId,
        });
        break;
    }
  }

  /** Parent customer must exist live in the active tenant — else 404 (BRD 15). */
  private async requireCustomer(tx: TenantTx, customerId: string): Promise<void> {
    const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } });
    if (!customer) throw new NotFoundException("Customer not found");
  }

  /** contact_id must reference a live contact OF THIS CUSTOMER (plan §7.2). */
  private async requireContactOfCustomer(
    tx: TenantTx,
    customerId: string,
    contactId: string,
  ): Promise<void> {
    const contact = await tx.contact.findFirst({
      where: { id: contactId, customerId, deletedAt: null },
    });
    if (!contact) {
      throw new BadRequestException("contactId must reference a contact of this customer");
    }
  }

  private requireDraft(invoice: InvoiceRow, verb: string): void {
    if (invoice.status !== "draft") {
      throw new ConflictException(`Only draft invoices can be ${verb}`);
    }
  }

  /** Duplicate invoice number (among live rows) → friendly 409 (plan §7.4). */
  private async ensureInvoiceNumberAvailable(
    tx: TenantTx,
    organisationId: string,
    invoiceNumber: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await tx.invoice.findFirst({
      where: {
        organisationId,
        invoiceNumber,
        deletedAt: null,
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
    });
    if (clash) {
      throw new ConflictException(
        `Invoice number '${invoiceNumber}' is already in use in this organisation`,
      );
    }
  }

  /** Creates the row, converting a unique-index race into the same friendly 409. */
  private async createRow(
    tx: TenantTx,
    data: Prisma.InvoiceUncheckedCreateInput,
  ): Promise<InvoiceRow> {
    try {
      return await tx.invoice.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          `Invoice number '${data.invoiceNumber}' is already in use in this organisation`,
        );
      }
      throw error;
    }
  }

  /** The org's business timezone (BRD 18.1); default Europe/London. */
  private async orgTimezone(tx: TenantTx, organisationId: string): Promise<string> {
    const settings = await tx.organisationSettings.findUnique({ where: { organisationId } });
    return settings?.timezone ?? DEFAULT_TIMEZONE;
  }

  private async findOrThrow(
    tx: TenantTx,
    customerId: string,
    invoiceId: string,
  ): Promise<InvoiceRow> {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, customerId, deletedAt: null },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  private toSummary(invoice: InvoiceRow, timezone: string): InvoiceSummary {
    return { ...invoice, displayStatus: deriveDisplayStatus(invoice, timezone) };
  }
}
