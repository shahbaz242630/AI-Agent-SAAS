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
    /** Null for system actions (e.g. the 1.5 reconcile sweep — schema comment). */
    actorUserId: string | null;
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

/**
 * The same trail, for an action that touches many rows at once (slice 1.6b —
 * reassigning a book of clients between mailboxes).
 *
 * ONE row per entity, not one summary row: someone will need to explain why a
 * PARTICULAR client was chased from a PARTICULAR address, and "412 clients
 * moved" cannot answer that (ALLOCATION-SCOPE trap 2).
 *
 * ONE statement, not a loop: 500 clients must not become 500 round trips inside
 * an open transaction (trap 3). `createMany` keeps the whole batch atomic with
 * the mutation it records.
 */
export async function writeAuditLogs(
  tx: TenantTx,
  entries: readonly {
    organisationId: string;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: Prisma.InputJsonValue;
  }[],
): Promise<void> {
  if (entries.length === 0) return;
  await tx.auditLog.createMany({
    data: entries.map((entry) => ({
      organisationId: entry.organisationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? Prisma.JsonNull,
    })),
  });
}
