import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { withTenant, withUser } from "@eva/database";
import { DEFAULT_ROLE_PERMISSIONS, ORGANISATION_ROLES, type OrganisationRole } from "@eva/types";
import type { PutRolePermissionsRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

export interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

export interface MemberSummary {
  userId: string;
  email: string;
  fullName: string | null;
  roleKey: string;
}

export interface RolePermissionGrant {
  roleKey: string;
  permissionKey: string;
}

/** The org's effective role→permission mapping (BRD 7 amendment, Slice 1.1). */
export interface RolePermissionsView {
  /** "default" = no custom rows, BRD matrix applies; "custom" = org mapping. */
  source: "default" | "custom";
  grants: RolePermissionGrant[];
}

/** Role keys allowed to change other members' roles (BRD 7). */
const ROLE_MANAGERS: ReadonlySet<string> = new Set(["owner", "administrator"]);

/** The BRD 7 default matrix flattened to grants, in stable order. */
function defaultGrants(): RolePermissionGrant[] {
  return ORGANISATION_ROLES.flatMap((roleKey: OrganisationRole) =>
    DEFAULT_ROLE_PERMISSIONS[roleKey].map((permissionKey) => ({ roleKey, permissionKey })),
  );
}

@Injectable()
export class OrganisationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Lists the caller's organisations via their own memberships (login path).
   * Under withUser only the membership rows are visible — the organisation
   * row itself needs the tenant context, so each org is read inside its own
   * withTenant (membership above is what proves access). N+1 is acceptable
   * at Phase 0 scale (a user belongs to a handful of orgs).
   */
  async listMine(authUser: AuthUser): Promise<OrganisationSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    const memberships = await withUser(this.prisma.db, user.id, (tx) =>
      tx.organisationMembership.findMany({
        where: { userId: user.id },
        include: { role: true },
      }),
    );
    return Promise.all(
      memberships.map((membership) =>
        withTenant(
          this.prisma.db,
          { organisationId: membership.organisationId, userId: user.id },
          async (tx) => {
            const organisation = await tx.organisation.findUniqueOrThrow({
              where: { id: membership.organisationId },
            });
            return {
              id: organisation.id,
              name: organisation.name,
              roleKey: membership.role.key,
            };
          },
        ),
      ),
    );
  }

  /**
   * Creates an org + default settings + owner membership for the caller. The
   * org id is generated upfront and the whole write runs inside withTenant
   * keyed to it — RLS WITH CHECK requires the active tenant to match.
   */
  async create(authUser: AuthUser, name: string): Promise<OrganisationSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    const organisationId = randomUUID();
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      const organisation = await tx.organisation.create({
        data: { id: organisationId, name, createdBy: user.id },
      });
      await tx.organisationSettings.create({
        data: {
          organisationId,
          timezone: "Europe/London",
          locale: "en-GB",
          createdBy: user.id,
        },
      });
      const ownerRole = await tx.role.findUniqueOrThrow({ where: { key: "owner" } });
      await tx.organisationMembership.create({
        data: {
          organisationId,
          userId: user.id,
          roleId: ownerRole.id,
          createdBy: user.id,
        },
      });
      // Slice 1.6a: entitlement fails CLOSED, so a new organisation with no
      // module rows can do nothing at all — not import an invoice, not connect
      // a mailbox. Granted in the same transaction as the organisation itself,
      // because an organisation that exists without its entitlement is a
      // customer locked out of the product they just signed up for.
      //
      // `manual` until billing exists; Paddle webhooks will write
      // `subscription` over the top later.
      await tx.organisationModule.create({
        data: {
          organisationId,
          moduleKey: "email_credit_controller",
          enabled: true,
          source: "manual",
          seats: 1,
          enabledAt: new Date(),
          createdBy: user.id,
        },
      });
      return { id: organisation.id, name: organisation.name, roleKey: ownerRole.key };
    });
  }

  /** Lists members of :organisationId — callers must be members themselves. */
  async listMembers(authUser: AuthUser, organisationId: string): Promise<MemberSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await this.requireMembership(tx, organisationId, user.id);
      const memberships = await tx.organisationMembership.findMany({
        where: { organisationId },
        include: { user: true, role: true },
      });
      return memberships.map((membership) => ({
        userId: membership.userId,
        email: membership.user.email,
        fullName: membership.user.fullName,
        roleKey: membership.role.key,
      }));
    });
  }

  /**
   * Changes a member's role — owner/administrator members only.
   *
   * Refuses to remove an organisation's last owner, because that state is
   * UNRECOVERABLE from inside the product: only owners and administrators may
   * change roles, and `modules:manage` is owner-only (slice 1.6a). A sole owner
   * demoting themselves can therefore leave a company unable to promote anyone
   * back AND unable to turn its own products on — with no route out that does
   * not involve us editing their database by hand.
   */
  async changeMemberRole(
    authUser: AuthUser,
    organisationId: string,
    targetUserId: string,
    roleKey: string,
  ): Promise<MemberSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      const caller = await this.requireMembership(tx, organisationId, user.id);
      if (!ROLE_MANAGERS.has(caller.role.key)) {
        throw new ForbiddenException("Only owner/administrator members can change roles");
      }
      const role = await tx.role.findUnique({ where: { key: roleKey } });
      if (!role) throw new BadRequestException(`Unknown role: ${roleKey}`);
      const target = await tx.organisationMembership.findUnique({
        where: { organisationId_userId: { organisationId, userId: targetUserId } },
        include: { user: true, role: true },
      });
      if (!target) throw new NotFoundException("Member not found");

      // Counted inside the same transaction as the update, so two owners
      // demoting each other at once cannot both pass the check and leave zero.
      if (target.role.key === "owner" && role.key !== "owner") {
        const owners = await tx.organisationMembership.count({
          where: { organisationId, role: { key: "owner" } },
        });
        if (owners <= 1) {
          throw new BadRequestException(
            "This is the organisation's only owner. Make someone else an owner first.",
          );
        }
      }

      const updated = await tx.organisationMembership.update({
        where: { id: target.id },
        data: { roleId: role.id },
      });
      // A privilege change is exactly the mutation that has to be explainable
      // afterwards. This was missing entirely until 2026-08-02.
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "member.role_changed",
        entityType: "organisation_membership",
        entityId: target.id,
        metadata: { targetUserId, fromRoleKey: target.role.key, toRoleKey: role.key },
      });
      return {
        userId: updated.userId,
        email: target.user.email,
        fullName: target.user.fullName,
        roleKey: role.key,
      };
    });
  }

  /**
   * The org's effective role→permission mapping — permissions:read. With no
   * custom rows the BRD default matrix applies and is reported as such.
   */
  async getRolePermissions(
    authUser: AuthUser,
    organisationId: string,
  ): Promise<RolePermissionsView> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "permissions:read");
      const rows = await tx.organisationRolePermission.findMany({
        where: { organisationId },
        include: { role: true },
      });
      if (rows.length === 0) return { source: "default", grants: defaultGrants() };
      return {
        source: "custom",
        grants: rows.map((row) => ({ roleKey: row.role.key, permissionKey: row.permissionKey })),
      };
    });
  }

  /**
   * Replaces the org's role→permission mapping — permissions:manage (default:
   * owner/administrator). Full-replace semantics: the body is the complete
   * desired mapping; an empty grants list resets the org to BRD defaults.
   * The change is audit-logged with the full resulting mapping.
   */
  async putRolePermissions(
    authUser: AuthUser,
    organisationId: string,
    input: PutRolePermissionsRequest,
  ): Promise<RolePermissionsView> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "permissions:manage");
      // Duplicate grants collapse — they carry no extra meaning.
      const grants = [
        ...new Map(
          input.grants.map((grant) => [
            `${grant.roleKey}\u0000${grant.permissionKey}`,
            { roleKey: grant.roleKey, permissionKey: grant.permissionKey },
          ]),
        ).values(),
      ];
      const roleIdByKey = new Map(
        (await tx.role.findMany()).map((role) => [role.key, role.id] as const),
      );
      await tx.organisationRolePermission.deleteMany({ where: { organisationId } });
      if (grants.length > 0) {
        await tx.organisationRolePermission.createMany({
          data: grants.map((grant) => ({
            organisationId,
            // Validated by zod against ORGANISATION_ROLES — always present.
            roleId: roleIdByKey.get(grant.roleKey) as string,
            permissionKey: grant.permissionKey,
            createdBy: user.id,
          })),
        });
      }
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "permissions.updated",
        entityType: "organisation",
        entityId: organisationId,
        metadata: { grants },
      });
      return { source: grants.length === 0 ? "default" : "custom", grants };
    });
  }

  /**
   * Proves the caller belongs to the org BEFORE any org data is read.
   * Non-members get a 404 — the API never confirms the org exists (BRD 15).
   */
  private async requireMembership(
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    organisationId: string,
    userId: string,
  ) {
    const membership = await tx.organisationMembership.findUnique({
      where: { organisationId_userId: { organisationId, userId } },
      include: { role: true },
    });
    if (!membership) throw new NotFoundException("Organisation not found");
    return membership;
  }
}
