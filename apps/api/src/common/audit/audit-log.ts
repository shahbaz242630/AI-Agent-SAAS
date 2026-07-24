import { Prisma } from "@eva/database";
import type { TenantTx } from "../permissions/permissions.js";

/**
 * Append-only audit trail writer (BRD 15). audit_logs is never updated and
 * never soft-deleted; every tenant mutation writes an entry inside the SAME
 * transaction as the mutation itself, so an action and its audit record
 * commit or roll back together.
 */
export async function writeAuditLog(
  tx: TenantTx,
  entry: {
    organisationId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      organisationId: entry.organisationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? Prisma.JsonNull,
    },
  });
}
