import type { TenantTx } from "../permissions/permissions.js";

/**
 * Suppression list — the permanent, cross-channel do-not-contact record
 * (BRD hard rule). There is NO update or delete code path anywhere; the
 * runtime role also has UPDATE/DELETE revoked at the database layer
 * (migration 0005). Service-level only in Slice 1.1: enforcement wiring
 * arrives with the send/call paths (1.5/1.7), which MUST call isSuppressed
 * before every attempt.
 */

/** Channels carried by the schema now; whatsapp is added additively in Phase 3. */
export const SUPPRESSION_CHANNELS = ["email", "call"] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];

/** Normalises a value for storage/comparison (emails case-fold). */
export function normaliseSuppressionValue(channel: SuppressionChannel, value: string): string {
  const trimmed = value.trim();
  return channel === "email" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Records a do-not-contact request. Idempotent on (org, channel, value):
 * re-suppressing an already-suppressed value is a no-op, never an error and
 * never a duplicate row.
 */
export async function addSuppression(
  tx: TenantTx,
  input: {
    organisationId: string;
    channel: SuppressionChannel;
    value: string;
    reason?: string;
    createdBy?: string;
  },
): Promise<void> {
  const value = normaliseSuppressionValue(input.channel, input.value);
  await tx.suppressionEntry.upsert({
    where: {
      organisationId_channel_value: {
        organisationId: input.organisationId,
        channel: input.channel,
        value,
      },
    },
    // Entries are permanent and immutable — an existing row is left untouched.
    update: {},
    create: {
      organisationId: input.organisationId,
      channel: input.channel,
      value,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
    },
  });
}

/** True when the value may not be contacted on the channel in this org. */
export async function isSuppressed(
  tx: TenantTx,
  organisationId: string,
  channel: SuppressionChannel,
  value: string,
): Promise<boolean> {
  const entry = await tx.suppressionEntry.findUnique({
    where: {
      organisationId_channel_value: {
        organisationId,
        channel,
        value: normaliseSuppressionValue(channel, value),
      },
    },
  });
  return entry !== null;
}
