import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { withTenant, withUser } from "@eva/database";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
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

/** Role keys allowed to change other members' roles (BRD 7). */
const ROLE_MANAGERS: ReadonlySet<string> = new Set(["owner", "administrator"]);

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

  /** Changes a member's role — owner/administrator members only. */
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
        include: { user: true },
      });
      if (!target) throw new NotFoundException("Member not found");
      const updated = await tx.organisationMembership.update({
        where: { id: target.id },
        data: { roleId: role.id },
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
