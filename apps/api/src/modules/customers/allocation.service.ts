import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import type {
  AllocateClientsResultDto,
  CustomerAllocationDto,
  CustomerAllocationListDto,
} from "@eva/types";
import type { AllocateClientsRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLogs } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

/**
 * Which mailbox chases which client (slice 1.6b).
 *
 * Slice 1.6a made an organisation able to HOLD several mailboxes; only the
 * primary ever sent. Allocation is what turns a paid seat into capacity: every
 * seat sends, and each owns a set of clients (`docs/ALLOCATION-SCOPE.md`).
 *
 * **Allocation fails OPEN, and that is deliberate.** An unallocated client is
 * chased from the DEFAULT mailbox, never dropped (ruling 1). Contrast
 * entitlements, which fail CLOSED. Absence of an entitlement means "not paid
 * for"; absence of an allocation means "not yet sorted". Fail closed on money,
 * fail open on filing.
 */
@Injectable()
export class AllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * GET .../customers/allocation — the book, with who chases whom.
   *
   * Two permissions, and the second one is the whole reason this reads rather
   * than writes: `customers:read` is a CORE permission, so it never 402s. An
   * organisation that switched Invoice Chasing off would otherwise get a fully
   * working allocation screen for a product it does not hold
   * (ALLOCATION-SCOPE trap 4). `mailbox:read` belongs to the email credit
   * controller, so the 402 arrives for free.
   */
  async list(authUser: AuthUser, organisationId: string): Promise<CustomerAllocationListDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "customers:read");
      await requirePermission(tx, organisationId, user.id, "mailbox:read");

      /**
       * Sequential, not `Promise.all`. These share one interactive transaction
       * client, and Prisma does not guarantee concurrent queries on a single
       * transaction are safe — the winnings would be one round trip and the
       * losses are the kind that only appear under real latency.
       */
      const customers = await tx.customer.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, emailAccountId: true },
        orderBy: { name: "asc" },
      });
      const mailboxes = await tx.emailAccount.findMany({
        where: { deletedAt: null },
        select: { id: true, emailAddress: true, isPrimary: true },
      });

      const addressById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox.emailAddress]));
      const defaultEmailAddress =
        mailboxes.find((mailbox) => mailbox.isPrimary)?.emailAddress ?? null;

      const allocations: CustomerAllocationDto[] = customers.map((customer) => {
        /**
         * Resolved HERE, on every read, and never stored (trap 1). A stamped
         * answer is correct on the day it is written and silently wrong the
         * moment the default mailbox changes.
         *
         * Task 6's `resolveSendingMailbox` adds the health ladder ruling 6
         * requires (a dead mailbox falls back to any healthy one). This screen
         * deliberately shows the FILING rather than the health outcome, so a
         * customer sees what they set, not a temporary substitution.
         */
        const allocatedAddress = customer.emailAccountId
          ? (addressById.get(customer.emailAccountId) ?? null)
          : null;
        return {
          customerId: customer.id,
          customerName: customer.name,
          emailAccountId: customer.emailAccountId,
          resolvedEmailAddress: allocatedAddress ?? defaultEmailAddress,
          isFallback: allocatedAddress === null,
        };
      });

      return { allocations, defaultEmailAddress };
    });
  }

  /**
   * PUT .../customers/allocation — file a set of clients under one mailbox.
   *
   * ONE transaction for the whole batch (trap 3). Moving 500 clients as 500
   * commits leaves a half-moved book if it fails in the middle, and half a book
   * is worse than none: nobody can tell which half.
   *
   * Permission bar per plan decision D1 — `customers:write` (this mutates a
   * customer, and filing clients is finance's job, not only an owner's) plus
   * `mailbox:read` (so the 402 fires when the product is off). Order follows the
   * standing rule: 404 → 403 → 402, so a stranger learns nothing about what the
   * company bought.
   */
  async allocate(
    authUser: AuthUser,
    organisationId: string,
    input: AllocateClientsRequest,
  ): Promise<AllocateClientsResultDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx) => {
        await requirePermission(tx, organisationId, user.id, "customers:write");
        await requirePermission(tx, organisationId, user.id, "mailbox:read");

        const target = await this.resolveTargetMailbox(tx, input.emailAccountId);
        // Duplicates in the request must not inflate the "moved" count or write
        // two audit rows for one client.
        const requestedIds = [...new Set(input.customerIds)];

        const customers = await tx.customer.findMany({
          where: { id: { in: requestedIds }, deletedAt: null },
          select: { id: true, emailAccountId: true },
        });

        /**
         * All or nothing. A partial success would report "42 moved" for a request
         * naming 43 clients and leave the caller guessing which one did not — and
         * under RLS a cross-tenant id is simply invisible, so "not found" here is
         * what the query genuinely returns rather than a euphemism for "forbidden"
         * (BRD 15).
         */
        if (customers.length !== requestedIds.length) {
          throw new NotFoundException("Customer not found");
        }

        // Re-filing a client under the mailbox it is already on is not a move.
        // Counting it would have the UI claim work it did not do, and would write
        // an audit row saying a client changed address when it did not.
        const changing = customers.filter((customer) => customer.emailAccountId !== target);
        if (changing.length === 0) return { moved: 0 };

        await tx.customer.updateMany({
          where: { id: { in: changing.map((customer) => customer.id) } },
          data: { emailAccountId: target },
        });

        await writeAuditLogs(
          tx,
          changing.map((customer) => ({
            organisationId,
            actorUserId: user.id,
            action: "customer.reassigned",
            entityType: "customer",
            entityId: customer.id,
            metadata: { from: customer.emailAccountId, to: target },
          })),
        );

        return { moved: changing.length };
      },
      /**
       * 30s, not Prisma's 5s default — the 1.5 PR #36 lesson, verbatim: staging
       * 500'd on a transaction at US-West↔London latency with only three
       * invoices. This one is larger. A full batch holds two permission lookups
       * (each a nested include plus a count), a findMany, an updateMany, and a
       * `createMany` of up to 500 audit rows. Timing out would roll back the
       * whole book and show a generic error, having moved nobody.
       */
      { timeout: 30_000 },
    );
  }

  /**
   * The mailbox a batch is being filed under, or null for "back to the
   * default" — the explicit un-file action, and a legal value under ruling 1.
   *
   * The database refuses a cross-tenant allocation outright (migration 0020's
   * composite foreign key), so this check is not the only thing standing
   * between us and sending from another company's address. It exists to turn
   * that constraint violation into a clean 404 instead of a 500.
   */
  private async resolveTargetMailbox(tx: TenantTx, emailAccountId: string | null) {
    if (emailAccountId === null) return null;
    const mailbox = await tx.emailAccount.findFirst({
      where: { id: emailAccountId, deletedAt: null },
      select: { id: true },
    });
    if (!mailbox) throw new NotFoundException("Mailbox not found");
    return mailbox.id;
  }
}
