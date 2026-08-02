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
/**
 * One `customer.reassigned` row per client filed under a mailbox, written
 * WITHOUT ever loading those clients into memory.
 *
 * `writeAuditLogs` needs the ids in Node first, which is fine for allocation —
 * bounded at 500 by the request schema. Disconnect and replace are bounded only
 * by how many clients a customer has: an organisation with 10,000 would pull
 * 10,000 ids across the wire and push 10,000 rows back, inside an open
 * transaction, and this file's own history (1.5 PR #36) is a transaction that
 * timed out at transatlantic latency.
 *
 * INSERT ... SELECT keeps it to one statement and constant memory, and returns
 * the affected-row count — which IS the number of live clients that moved, so
 * the caller needs no separate COUNT either.
 *
 * `id` is supplied explicitly: audit_logs.id is NOT NULL with no database
 * default (Prisma generates it client-side), so raw SQL must produce one.
 */
export async function auditReassignedByMailbox(
  tx: TenantTx,
  entry: {
    organisationId: string;
    actorUserId: string | null;
    fromEmailAccountId: string;
    /** Null when the clients fall back to the default (a disconnect). */
    toEmailAccountId: string | null;
    reason: string;
  },
): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO audit_logs (id, organisation_id, actor_user_id, action, entity_type, entity_id, metadata)
    SELECT gen_random_uuid(),
           ${entry.organisationId}::uuid,
           ${entry.actorUserId}::uuid,
           'customer.reassigned',
           'customer',
           c.id::text,
           jsonb_build_object(
             'from', ${entry.fromEmailAccountId}::text,
             'to', ${entry.toEmailAccountId}::text,
             'reason', ${entry.reason}::text
           )
    FROM customers c
    WHERE c.email_account_id = ${entry.fromEmailAccountId}::uuid
      AND c.deleted_at IS NULL`;
}

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
