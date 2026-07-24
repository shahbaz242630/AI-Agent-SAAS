import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import type { CreateContactRequest, UpdateContactRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

export interface ContactSummary {
  id: string;
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** Lists a customer's contacts (soft-deleted excluded) — contacts:read. */
  async list(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
  ): Promise<ContactSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "contacts:read");
      await this.requireCustomer(tx, customerId);
      return tx.contact.findMany({
        where: { customerId, deletedAt: null },
        orderBy: { name: "asc" },
      });
    });
  }

  /** Creates a contact under a customer — contacts:write. Audit-logged. */
  async create(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    input: CreateContactRequest,
  ): Promise<ContactSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "contacts:write");
      await this.requireCustomer(tx, customerId);
      const contact = await tx.contact.create({
        data: {
          organisationId,
          customerId,
          name: input.name,
          email: input.email?.toLowerCase() ?? null,
          phone: input.phone ?? null,
          jobTitle: input.jobTitle ?? null,
          createdBy: user.id,
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "contact.created",
        entityType: "contact",
        entityId: contact.id,
        metadata: { customerId, name: contact.name },
      });
      return contact;
    });
  }

  /** Reads one contact — contacts:read. Cross-tenant/deleted ids are 404. */
  async getById(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    contactId: string,
  ): Promise<ContactSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "contacts:read");
      return this.findOrThrow(tx, customerId, contactId);
    });
  }

  /** Updates a contact — contacts:write. Audit-logged. */
  async update(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    contactId: string,
    input: UpdateContactRequest,
  ): Promise<ContactSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "contacts:write");
      await this.findOrThrow(tx, customerId, contactId);
      const contact = await tx.contact.update({
        where: { id: contactId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.email !== undefined ? { email: input.email.toLowerCase() } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "contact.updated",
        entityType: "contact",
        entityId: contact.id,
        metadata: {
          changedFields: Object.keys(input).filter(
            (key) => input[key as keyof UpdateContactRequest] !== undefined,
          ),
        },
      });
      return contact;
    });
  }

  /** Soft-deletes a contact (BRD 10) — contacts:write. Audit-logged. */
  async remove(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    contactId: string,
  ): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "contacts:write");
      await this.findOrThrow(tx, customerId, contactId);
      await tx.contact.update({ where: { id: contactId }, data: { deletedAt: new Date() } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "contact.deleted",
        entityType: "contact",
        entityId: contactId,
        metadata: { customerId },
      });
    });
  }

  /** Parent customer must exist live in the active tenant — else 404 (BRD 15). */
  private async requireCustomer(tx: TenantTx, customerId: string): Promise<void> {
    const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } });
    if (!customer) throw new NotFoundException("Customer not found");
  }

  private async findOrThrow(
    tx: TenantTx,
    customerId: string,
    contactId: string,
  ): Promise<ContactSummary> {
    const contact = await tx.contact.findFirst({
      where: { id: contactId, customerId, deletedAt: null },
    });
    if (!contact) throw new NotFoundException("Contact not found");
    return contact;
  }
}
