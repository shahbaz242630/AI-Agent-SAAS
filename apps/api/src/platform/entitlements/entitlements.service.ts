import { BadRequestException, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import {
  isModuleLive,
  MODULE_CAPABILITIES,
  MODULE_DEPENDENCIES,
  MODULE_KEYS,
  moduleName,
  type Capability,
  type ModuleKey,
  type ModuleStatusDto,
} from "@eva/types";
import type { SetModuleInput } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
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
      await requirePermission(tx, organisationId, user.id, "modules:read");
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

      /**
       * ⚠️ DEPENDENCIES FIRST, THEN "DOES IT EXIST" — AND THE ORDER IS
       * DELIBERATE. Every product with a dependency is currently unbuilt, so
       * checking existence first would make the dependency rule unreachable
       * from any live test, and a rule nothing can exercise is a rule that
       * rots. The prerequisite answer is also the more specific of the two
       * when both apply. Revisit the day a second product ships.
       */
      if (input.enabled) {
        await this.assertDependenciesMet(tx, moduleKey);
        this.assertModuleIsBuilt(moduleKey);
      }
      const seats = await this.resolveSeats(tx, moduleKey, input, existing?.seats ?? 1);

      const now = new Date();
      /**
       * `endsAt: null` on BOTH branches, for two different reasons.
       *
       * **Enabling** clears any scheduled end: turning a product back on before
       * the period runs out cancels the cancellation. No new charge, no
       * interruption, no panic after a mis-click — the customer simply carries
       * on. Leaving it set would stop the product days later for somebody who
       * had already changed their mind.
       *
       * **Disabling** sets it to null because there is no billing period to
       * compute an end from yet — Paddle is not wired up, so switching off is
       * immediate and honest rather than promising a date nothing can keep. The
       * column and the CHECK (migration 0024) are the shape Paddle's period end
       * will land in; when it does, THIS is the line that changes, and the
       * screen already reads `endsAt` to word itself.
       */
      const data = {
        enabled: input.enabled,
        seats,
        endsAt: null,
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

      // Enabling and resizing share this endpoint, so the verb has to be
      // derived rather than read off `input.enabled` — otherwise buying a seat
      // on an already-on product audits as `module.enabled`, and seats are
      // money. `previousSeats` is recorded for the same reason: a billing
      // dispute needs to see the change, not just the result.
      const enabledChanged = !existing || existing.enabled !== input.enabled;
      const action = enabledChanged
        ? input.enabled
          ? "module.enabled"
          : "module.disabled"
        : "module.seats_changed";

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action,
        entityType: "organisation_module",
        entityId: account.id,
        metadata: { moduleKey, seats, previousSeats: existing?.seats ?? null },
      });
      this.logger.info({ moduleKey, enabled: input.enabled, seats }, "organisation module updated");
      return this.describeAll(tx);
    });
  }

  /**
   * A product that does not exist cannot be turned on (found by walking,
   * 2026-08-18).
   *
   * ⚠️ THE SCREEN HIDING THE BUTTON IS NOT WHAT STOPS THIS. Three of the four
   * products are unbuilt — they carry no permissions in `PERMISSION_MODULES`,
   * so enabling one wrote an entitlement row, showed "On", and delivered
   * nothing.
   * A customer would have been told they had bought something they had not.
   *
   * ⚠️ ONLY ENABLING IS REFUSED. If an unbuilt product is somehow already on —
   * an older row, a seeded environment — turning it OFF has to keep working,
   * or the guard traps the very state it exists to prevent.
   */
  private assertModuleIsBuilt(moduleKey: ModuleKey): void {
    if (isModuleLive(moduleKey)) return;
    throw new BadRequestException(
      `${moduleName(moduleKey)} isn't built yet, so it can't be turned on.`,
    );
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
      // Spelled out rather than "1 seats" / "1 mailboxes are": this string is
      // read by a customer at the moment they are being told no.
      const connected = used === 1 ? "1 mailbox is" : `${used} mailboxes are`;
      const seatWord = input.seats === 1 ? "seat" : "seats";
      /**
       * Name the clients too (slice 1.6b, ALLOCATION-SCOPE trap 6).
       *
       * Mailboxes are not the whole cost of this decision. Disconnecting one
       * moves every client filed under it back to the default (ruling 3), and
       * somebody lowering a seat count to save money deserves to know that
       * before they start rather than discover it after. Only mentioned when
       * there is something to lose.
       */
      const filed = await tx.customer.count({
        where: { deletedAt: null, emailAccountId: { not: null } },
      });
      const clientNote =
        filed > 0
          ? ` ${filed === 1 ? "1 client is" : `${filed} clients are`} filed under your mailboxes; any whose mailbox is disconnected will be chased from your default mailbox instead.`
          : "";
      throw new BadRequestException(
        `${connected} connected; disconnect ${used - input.seats} before lowering to ${input.seats} ${seatWord}.${clientNote}`,
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

  /**
   * Which machinery is actually set up for this organisation right now.
   *
   * ⚠️ READINESS IS NOT ENTITLEMENT, AND THE TWO MUST NOT MERGE AGAIN. A
   * customer who owns the lead agent but has connected no mailbox owns it —
   * they simply cannot use it yet. Refusing the sale over a missing
   * prerequisite is what stopped three of the BRD's six packages being
   * sellable; saying what is missing and linking the fix is the 1.13
   * `noWorkingMailbox` pattern.
   */
  private async resolveCapabilities(tx: TenantTx): Promise<Set<Capability>> {
    const held = new Set<Capability>();
    /**
     * The invoice ledger is our own schema — it ships with the code, so every
     * organisation has it. It is listed rather than assumed because the BRD
     * names it ("Email Credit Controller data model present") as what voice
     * credit control needs, and writing it down is what stops somebody
     * re-reading that line as "must buy invoice follow-up" a second time.
     */
    held.add("invoice_ledger");
    if ((await tx.emailAccount.count({ where: { deletedAt: null } })) > 0) held.add("mailbox");
    // `voice` is deliberately absent: there is no voice stack yet, so both
    // voice products correctly report it missing rather than claiming readiness.
    return held;
  }

  private async describeAll(tx: TenantTx): Promise<ModuleStatusDto[]> {
    const rows = await tx.organisationModule.findMany({ where: { deletedAt: null } });
    const byKey = new Map(rows.map((row) => [row.moduleKey, row]));
    const enabled = new Set(rows.filter((row) => row.enabled).map((row) => row.moduleKey));
    const seatsUsed = await this.countSeatsUsed(tx, "email_credit_controller");
    const capabilities = await this.resolveCapabilities(tx);

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
          endsAt: row?.endsAt?.toISOString() ?? null,
          missingDependencies: MODULE_DEPENDENCIES[moduleKey].filter(
            (dependency) => !enabled.has(dependency),
          ),
          /**
           * Reported for products the organisation does NOT hold as well, and
           * that is the point: it is what lets the screen say "you'll need to
           * connect a mailbox" BEFORE the sale rather than refusing it.
           */
          missingCapabilities: MODULE_CAPABILITIES[moduleKey].filter(
            (capability) => !capabilities.has(capability),
          ),
        };
      }),
    );
  }
}
