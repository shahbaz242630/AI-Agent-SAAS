import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DEFAULT_ROLE_PERMISSIONS, type OrganisationRole, type PermissionKey } from "@eva/types";
import type { withTenant } from "@eva/database";

/** Transaction handle as passed by withTenant/withUser callbacks. */
export type TenantTx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * Data-driven authorisation (Slice 1.1; BRD 7 amendment, plan §7.1). Guards
 * never name roles — they resolve a permission key against the organisation's
 * own mapping, falling back to the coded BRD default matrix when the org has
 * no custom rows. High-risk actions (legal threats, fees, discounts, marking
 * paid, commitments) are never permission-keyed: they stay human-confirmed
 * regardless of configuration (BRD hard rules).
 */

/** Effective check: custom mapping when the org has one, else BRD defaults. */
export async function hasPermission(
  tx: TenantTx,
  organisationId: string,
  roleKey: string,
  permissionKey: PermissionKey,
): Promise<boolean> {
  const customGrants = await tx.organisationRolePermission.count({
    where: { organisationId },
  });
  if (customGrants === 0) {
    return DEFAULT_ROLE_PERMISSIONS[roleKey as OrganisationRole]?.includes(permissionKey) ?? false;
  }
  const grant = await tx.organisationRolePermission.findFirst({
    where: { organisationId, permissionKey, role: { key: roleKey } },
  });
  return grant !== null;
}

/**
 * Proves membership (404 for non-members — the API never confirms the org
 * exists, BRD 15) then the permission (403 for members lacking it). Returns
 * the caller's membership for callers that also need the role.
 */
export async function requirePermission(
  tx: TenantTx,
  organisationId: string,
  userId: string,
  permissionKey: PermissionKey,
) {
  const membership = await tx.organisationMembership.findUnique({
    where: { organisationId_userId: { organisationId, userId } },
    include: { role: true },
  });
  if (!membership) throw new NotFoundException("Organisation not found");
  if (!(await hasPermission(tx, organisationId, membership.role.key, permissionKey))) {
    throw new ForbiddenException(
      `Role '${membership.role.key}' lacks permission '${permissionKey}' in this organisation`,
    );
  }
  return membership;
}
