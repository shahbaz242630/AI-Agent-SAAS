import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import type { CreateCustomerRequest, UpdateCustomerRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

export interface CustomerSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** Lists the org's customers (soft-deleted excluded) — customers:read. */
  async list(authUser: AuthUser, organisationId: string): Promise<CustomerSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "customers:read");
      return tx.customer.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      });
    });
  }

  /** Creates a customer — customers:write. Mutation is audit-logged (BRD 15). */
  async create(
    authUser: AuthUser,
    organisationId: string,
    input: CreateCustomerRequest,
  ): Promise<CustomerSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "customers:write");
      const customer = await tx.customer.create({
        data: {
          organisationId,
          name: input.name,
          email: input.email?.toLowerCase() ?? null,
          phone: input.phone ?? null,
          reference: input.reference ?? null,
          createdBy: user.id,
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "customer.created",
        entityType: "customer",
        entityId: customer.id,
        metadata: { name: customer.name },
      });
      return customer;
    });
  }

  /** Reads one customer — customers:read. Cross-tenant/deleted ids are 404. */
  async getById(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
  ): Promise<CustomerSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "customers:read");
      return this.findOrThrow(tx, customerId);
    });
  }

  /** Updates a customer — customers:write. Mutation is audit-logged. */
  async update(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    input: UpdateCustomerRequest,
  ): Promise<CustomerSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "customers:write");
      await this.findOrThrow(tx, customerId);
      const customer = await tx.customer.update({
        where: { id: customerId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.email !== undefined ? { email: input.email.toLowerCase() } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.reference !== undefined ? { reference: input.reference } : {}),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "customer.updated",
        entityType: "customer",
        entityId: customer.id,
        metadata: {
          changedFields: Object.keys(input).filter(
            (key) => input[key as keyof UpdateCustomerRequest] !== undefined,
          ),
        },
      });
      return customer;
    });
  }

  /** Soft-deletes a customer (BRD 10) — customers:write. Audit-logged. */
  async remove(authUser: AuthUser, organisationId: string, customerId: string): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "customers:write");
      await this.findOrThrow(tx, customerId);
      await tx.customer.update({ where: { id: customerId }, data: { deletedAt: new Date() } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "customer.deleted",
        entityType: "customer",
        entityId: customerId,
      });
    });
  }

  /**
   * Finds a live customer inside the active tenant. Under RLS a cross-tenant
   * id is simply invisible → 404, never 403 (BRD 15).
   */
  private async findOrThrow(
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    customerId: string,
  ): Promise<CustomerSummary> {
    const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }
}
