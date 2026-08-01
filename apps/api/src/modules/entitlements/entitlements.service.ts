import { BadRequestException, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import { MODULE_DEPENDENCIES, MODULE_KEYS, type ModuleKey, type ModuleStatusDto } from "@eva/types";
import type { SetModuleInput } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

/**
 * Which products an organisation holds (slice 1.6a).
 *
 * Everything here is guarded by `core` permissions on purpose: an organisation
 * with nothing must still be able to see what exists and turn something on,
 * or it can never become a customer. That is the lockout trap, and it is the
 * reason `modules:manage` maps to `core` rather than to a product.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EntitlementsService.name);
  }

  /** GET .../modules — always all four products, held or not, so the UI can
   *  show what is available to buy alongside what is owned. */
  async list(authUser: AuthUser, organisationId: string): Promise<ModuleStatusDto[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "permissions:read");
      return this.describeAll(tx);
    });
  }

  /**
   * PUT .../modules/:moduleKey — turn a product on or off, or resize its
   * seats. `modules:manage`, owner-only by default: this is the one action
   * that commits the business to money.
   */
  async setModule(
    authUser: AuthUser,
    organisationId: string,
    moduleKey: ModuleKey,
    input: SetModuleInput,
  ): Promise<ModuleStatusDto[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "modules:manage");
      const existing = await tx.organisationModule.findFirst({
        where: { moduleKey, deletedAt: null },
      });

      if (input.enabled) await this.assertDependenciesMet(tx, moduleKey);
      const seats = await this.resolveSeats(tx, moduleKey, input, existing?.seats ?? 1);

      const now = new Date();
      const data = {
        enabled: input.enabled,
        seats,
        ...(input.enabled ? { enabledAt: now, disabledAt: null } : { disabledAt: now }),
      };
      const account = existing
        ? await tx.organisationModule.update({ where: { id: existing.id }, data })
        : await tx.organisationModule.create({
            data: {
              ...data,
              organisationId,
              moduleKey,
              // `manual` here; Paddle webhooks write `subscription` later. The
              // table stays authoritative for ENFORCEMENT and Paddle for
              // BILLING — deriving entitlement live from Paddle would let a
              // Paddle outage disable every customer at once.
              source: "manual",
              createdBy: user.id,
            },
          });

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: input.enabled ? "module.enabled" : "module.disabled",
        entityType: "organisation_module",
        entityId: account.id,
        metadata: { moduleKey, seats },
      });
      this.logger.info({ moduleKey, enabled: input.enabled, seats }, "organisation module updated");
      return this.describeAll(tx);
    });
  }

  /**
   * Dependencies are validated when ENABLING and never re-derived per request.
   * A stored invalid combination is a bug to prevent at the write, not a cost
   * to pay on every permission check.
   */
  private async assertDependenciesMet(tx: TenantTx, moduleKey: ModuleKey): Promise<void> {
    const required = MODULE_DEPENDENCIES[moduleKey];
    if (required.length === 0) return;
    const enabled = new Set(
      (await tx.organisationModule.findMany({ where: { enabled: true, deletedAt: null } })).map(
        (row) => row.moduleKey,
      ),
    );
    const missing = required.filter((dependency) => !enabled.has(dependency));
    if (missing.length > 0) {
      // Names the prerequisite rather than saying "invalid": the customer can
      // only act on this if we tell them what to buy first.
      throw new BadRequestException(`${moduleKey} needs ${missing.join(", ")} enabled first`);
    }
  }

  /**
   * Lowering seats below what is already in use is refused, naming the number
   * that must be disconnected. A human is present — tell them, rather than
   * silently leaving an organisation over its limit.
   *
   * NOTE: the Paddle downgrade case is deliberately NOT handled here. A billing
   * webhook cannot be refused — the customer has already been charged the lower
   * amount — so it needs an over-limit state that keeps mailboxes connected but
   * stops them sending. That cannot be specified before the Paddle flow exists
   * (ENTITLEMENTS-SCOPE §8.6).
   */
  private async resolveSeats(
    tx: TenantTx,
    moduleKey: ModuleKey,
    input: SetModuleInput,
    current: number,
  ): Promise<number> {
    // Absent `seats` means "leave it alone" — enabling and resizing share this
    // endpoint, and an enable must not silently reset a paid seat count.
    if (input.seats === undefined) return current;
    const used = await this.countSeatsUsed(tx, moduleKey);
    if (used !== null && input.seats < used) {
      throw new BadRequestException(
        `${used} mailboxes are connected; disconnect ${used - input.seats} before lowering to ${input.seats} seats`,
      );
    }
    return input.seats;
  }

  /** Units in use. Only the email credit controller has anything countable
   *  today; a voice product's unit would be a phone number. */
  private async countSeatsUsed(tx: TenantTx, moduleKey: ModuleKey): Promise<number | null> {
    if (moduleKey !== "email_credit_controller") return null;
    return tx.emailAccount.count({ where: { deletedAt: null } });
  }

  private async describeAll(tx: TenantTx): Promise<ModuleStatusDto[]> {
    const rows = await tx.organisationModule.findMany({ where: { deletedAt: null } });
    const byKey = new Map(rows.map((row) => [row.moduleKey, row]));
    const enabled = new Set(rows.filter((row) => row.enabled).map((row) => row.moduleKey));
    const seatsUsed = await this.countSeatsUsed(tx, "email_credit_controller");

    return Promise.all(
      MODULE_KEYS.map(async (moduleKey) => {
        const row = byKey.get(moduleKey);
        return {
          moduleKey,
          enabled: row?.enabled ?? false,
          source: (row?.source as ModuleStatusDto["source"]) ?? null,
          seats: row?.seats ?? 1,
          seatsUsed: moduleKey === "email_credit_controller" ? seatsUsed : null,
          enabledAt: row?.enabledAt?.toISOString() ?? null,
          disabledAt: row?.disabledAt?.toISOString() ?? null,
          missingDependencies: MODULE_DEPENDENCIES[moduleKey].filter(
            (dependency) => !enabled.has(dependency),
          ),
        };
      }),
    );
  }
}
