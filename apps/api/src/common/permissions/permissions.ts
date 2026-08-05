import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_MODULE,
  type OrganisationRole,
  type PermissionKey,
} from "@eva/types";
import type { withTenant } from "@eva/database";
import { ModuleNotEntitledException } from "./module-not-entitled.exception.js";

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

/**
 * Everything a role may do here: the org's custom mapping when it has one, else
 * the BRD default matrix.
 *
 * ⚠️ THIS IS THE ONLY PLACE THE RULE LIVES, and `hasPermission` below is a
 * lookup in its result rather than a second implementation of it. The
 * alternative — one function answering "may I?" and another answering "what may
 * I?" — is two copies of an authorisation rule, and this project has already
 * watched two copies of one rule disagree within an hour of the original
 * changing.
 *
 * ⚠️ THE ROLE HALF ONLY. It says nothing about whether the organisation holds
 * the product that owns a permission — that is the 402 gate in
 * `requirePermission`, and the two must stay distinguishable because they need
 * different answers from a screen: a 403 means "ask an owner", a 402 means
 * "buy the product". Collapsing them here would make the caller name the wrong
 * one (standing rule §0d).
 *
 * Costs the same two queries as a single check, whatever the answer's length.
 */
export async function effectivePermissions(
  tx: TenantTx,
  organisationId: string,
  roleKey: string,
): Promise<PermissionKey[]> {
  const customGrants = await tx.organisationRolePermission.count({
    where: { organisationId },
  });
  if (customGrants === 0) {
    return [...(DEFAULT_ROLE_PERMISSIONS[roleKey as OrganisationRole] ?? [])];
  }
  const grants = await tx.organisationRolePermission.findMany({
    where: { organisationId, role: { key: roleKey } },
    select: { permissionKey: true },
  });
  /**
   * Filtered against `PERMISSION_KEYS` rather than returned raw. A row naming a
   * permission this build does not have is a leftover from a removed feature or
   * a hand-edited database, and passing it through would put an unknown string
   * into a typed list that the rest of the app trusts. Fail closed: unknown
   * means not held.
   */
  const known = new Set<string>(PERMISSION_KEYS);
  return grants
    .map((grant) => grant.permissionKey)
    .filter((key): key is PermissionKey => known.has(key));
}

/** Effective check: custom mapping when the org has one, else BRD defaults. */
export async function hasPermission(
  tx: TenantTx,
  organisationId: string,
  roleKey: string,
  permissionKey: PermissionKey,
): Promise<boolean> {
  return (await effectivePermissions(tx, organisationId, roleKey)).includes(permissionKey);
}

/**
 * Three gates, and the ORDER is a deliberate information-disclosure choice:
 *
 * 1. **membership** — 404 for non-members. The API never confirms an
 *    organisation exists (BRD 15), so this must come first: a stranger must not
 *    learn which products a company has bought by reading our status codes.
 * 2. **role** — 403 for members whose role lacks the permission. Ahead of the
 *    module check so a junior member cannot enumerate the account's
 *    subscriptions either.
 * 3. **entitlement** — 402 when the organisation has not got the product that
 *    owns this permission (slice 1.6a).
 *
 * The entitlement rides the SAME query as the membership rather than adding a
 * round trip — the 1.5 PR #36 lesson is that round trips are what hurt at
 * US↔London latency, and this function runs on essentially every request.
 *
 * **Absence of a row means NOT entitled.** Fail closed: a lost or un-backfilled
 * row must lock a product, never quietly unlock one.
 *
 * Returns the caller's membership for callers that also need the role.
 */
export async function requirePermission(
  tx: TenantTx,
  organisationId: string,
  userId: string,
  permissionKey: PermissionKey,
) {
  const membership = await tx.organisationMembership.findUnique({
    where: { organisationId_userId: { organisationId, userId } },
    include: {
      role: true,
      organisation: {
        include: {
          // At most four rows, and RLS has already scoped them to this
          // organisation. Cheaper than a second query for the one we need.
          modules: { where: { deletedAt: null }, select: { moduleKey: true, enabled: true } },
        },
      },
    },
  });
  if (!membership) throw new NotFoundException("Organisation not found");
  if (!(await hasPermission(tx, organisationId, membership.role.key, permissionKey))) {
    throw new ForbiddenException(
      `Role '${membership.role.key}' lacks permission '${permissionKey}' in this organisation`,
    );
  }
  const requiredModule = PERMISSION_MODULE[permissionKey];
  if (requiredModule !== "core") {
    const entitled = membership.organisation.modules.some(
      (module) => module.moduleKey === requiredModule && module.enabled,
    );
    if (!entitled) throw new ModuleNotEntitledException(requiredModule);
  }
  return membership;
}
