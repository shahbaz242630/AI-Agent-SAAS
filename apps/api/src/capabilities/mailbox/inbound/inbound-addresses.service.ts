import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { withTenant } from "@eva/database";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../../../platform/users/users.service.js";
import { requirePermission, type TenantTx } from "../../../platform/permissions/permissions.js";
import { writeAuditLog } from "../../../platform/audit/audit-log.js";
import { isUniqueViolationOn } from "../../../common/errors/database-fault.js";
import type { AuthUser } from "../../../platform/authentication/current-auth-user.decorator.js";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
import { isValidLocalPart, newLocalPart } from "./inbound-address.js";

/** A customer's front door, as a screen reads it. */
export interface InboundAddressView {
  address: string;
  /** When this door was opened. The address on their website is this old. */
  issuedAt: Date;
}

/**
 * ⚠️ 1 IN ~887 MILLION, AND IT STILL HAS TO BE HANDLED. Three attempts is not
 * about the odds of a random collision — it is about the RACE. Two requests for
 * the same organisation's address arriving together both find nothing and both
 * insert; one loses. The loser re-reads and returns the winner's address, which
 * is the correct answer to the question it was asked.
 */
const ALLOCATION_ATTEMPTS = 3;

@Injectable()
export class InboundAddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * The organisation's front door, opening one if it has never had a visitor —
   * `leads:read`.
   *
   * ⚠️ A READ THAT CAN WRITE, AND THAT IS THE POINT. There is no other honest
   * moment to allocate. Doing it when the product is switched on would mean the
   * platform's entitlement code creating a row for a capability on behalf of a
   * product — the platform knowing the name of a thing plugged into it, which
   * is the one rule the architecture calls load-bearing. Allocating on first
   * sight keeps the dependency pointing the right way, and `resolveOrProvision`
   * on the user path is the same shape for the same reason.
   *
   * ⚠️ `leads:read` ALREADY CARRIES THE ENTITLEMENT. `requirePermission` answers
   * 402 when the organisation does not hold the product that owns the
   * permission, and `leads:read` is carried by `lead_follow_up_email` alone. So
   * an organisation with only invoice chasing never reaches the allocation at
   * all — no address is issued for a product nobody bought.
   */
  async getOrAllocate(authUser: AuthUser, organisationId: string): Promise<InboundAddressView> {
    const user = await this.usersService.resolveOrProvision(authUser);

    for (let attempt = 1; attempt <= ALLOCATION_ATTEMPTS; attempt += 1) {
      const existing = await withTenant(
        this.prisma.db,
        { organisationId, userId: user.id },
        async (tx) => {
          await requirePermission(tx, organisationId, user.id, "leads:read");
          return this.liveAddress(tx);
        },
      );
      if (existing) return existing;

      /**
       * ⚠️ REFUSED, NOT DEFAULTED. Without a domain there is no address to
       * issue, and inventing one would print a dead address on a customer's
       * website — every enquiry sent to it lost with no error anywhere. See the
       * note on `INBOUND_EMAIL_DOMAIN` in `env.ts`.
       */
      const domain = this.env.INBOUND_EMAIL_DOMAIN.trim().toLowerCase();
      if (!domain) {
        throw new ServiceUnavailableException(
          "Inbound email is not configured on this environment, so no enquiry address can be issued",
        );
      }

      try {
        return await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
          await requirePermission(tx, organisationId, user.id, "leads:read");
          return this.allocate(tx, organisationId, user.id, domain);
        });
      } catch (error) {
        /**
         * ⚠️ CAUGHT OUT HERE, NOT INSIDE THE TRANSACTION, AND THE DIFFERENCE IS
         * NOT STYLISTIC. A constraint violation aborts the Postgres transaction
         * at the server: catching it in the callback leaves a handle on which
         * every further query fails with "current transaction is aborted", and
         * the audit line or read that a later change adds after the catch would
         * fail for a reason nothing in the code suggests. Letting it propagate
         * rolls the transaction back cleanly and retries with a fresh one.
         *
         * Either index can refuse. `organisation_id` means somebody else opened
         * the door first — the next pass reads their address and returns it.
         * `address` means the random tail collided — the next pass draws
         * another. One handler, because the answer to both is "go round again".
         */
        const raced =
          isUniqueViolationOn(error, "organisation_id") || isUniqueViolationOn(error, "address");
        if (!raced) throw error;
      }
    }

    /**
     * Three losses in a row is not contention, it is a fault — most likely the
     * live-address index and the read disagreeing. Failing loudly beats a
     * fourth attempt, because the caller is a screen waiting on an answer.
     */
    throw new ServiceUnavailableException("Could not issue an enquiry address; please try again");
  }

  /** The one live door, or nothing. Revoked rows are not doors. */
  private async liveAddress(tx: TenantTx): Promise<InboundAddressView | null> {
    const row = await tx.inboundAddress.findFirst({
      where: { deletedAt: null },
      select: { address: true, createdAt: true },
    });
    return row ? { address: row.address, issuedAt: row.createdAt } : null;
  }

  /**
   * Open a door. Throws the raw unique violation when the database refuses;
   * `getOrAllocate` reads it outside the transaction and goes round again.
   */
  private async allocate(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    domain: string,
  ): Promise<InboundAddressView> {
    const organisation = await tx.organisation.findFirst({
      where: { id: organisationId, deletedAt: null },
      select: { name: true },
    });
    if (!organisation) throw new NotFoundException("Organisation not found");

    const localPart = newLocalPart(organisation.name);
    /**
     * ⚠️ CHECKED BEFORE THE INSERT, THOUGH THE DATABASE WOULD CATCH IT ANYWAY.
     * A CHECK violation surfaces as an opaque 500 naming a constraint; this
     * turns a generator bug into a message that says which value was wrong.
     * The database stays the arbiter — this is only the better error.
     */
    if (!isValidLocalPart(localPart)) {
      throw new ServiceUnavailableException(
        `Generated an invalid enquiry address local part: '${localPart}'`,
      );
    }
    const address = `${localPart}@${domain}`;

    const row = await tx.inboundAddress.create({
      data: { organisationId, address, localPart, domain, createdBy: userId },
      select: { id: true, address: true, createdAt: true },
    });

    await writeAuditLog(tx, {
      organisationId,
      actorUserId: userId,
      action: "inbound_address.issued",
      entityType: "inbound_address",
      entityId: row.id,
      /**
       * The address itself, deliberately. An audit log usually holds as little
       * as it can — but this one records the issuing of a public, permanent
       * identifier that will be printed on a website, and "an address was
       * issued" without saying which is a line nobody can use.
       */
      metadata: { address: row.address },
    });

    return { address: row.address, issuedAt: row.createdAt };
  }
}
