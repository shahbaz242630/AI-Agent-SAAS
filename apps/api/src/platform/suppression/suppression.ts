import type { TenantTx } from "../permissions/permissions.js";

/**
 * Do-not-contact — the permanent, cross-channel record (BRD hard rule:
 * actioned "immediately and permanently… and applies across all channels").
 *
 * ⚠️ SINCE MIGRATION 0028 THIS IS AN APPEND-ONLY LOG, NOT A LIST. A row says
 * "on this date somebody suppressed / corrected this value". The current state
 * is whatever the NEWEST row says. Nothing is ever updated or deleted — the
 * runtime role holds no UPDATE or DELETE on the table, so permanence is a
 * database fact and not a convention this file could quietly drop.
 *
 * ⚠️ A CORRECTION IS FOR AN ENTRY THAT SHOULD NEVER HAVE BEEN MADE. It is NOT
 * for changing your mind about a request somebody actually made — that person
 * stays unreachable forever, which is the whole point of the rule. We cannot
 * tell the two apart from here, so the screen says so plainly and every
 * correction is audit-logged with a stated reason.
 *
 * ⚠️ EVERY READ GOES THROUGH THIS FILE. A query that asks "does a row exist"
 * was the right question until 0028 and is a bug after it: it reads a corrected
 * entry as live. `isSuppressed` and `suppressedValues` are the only two ways to
 * ask, and the bulk one exists so no caller is tempted to hand-roll it.
 */

/** Channels carried by the schema now; whatsapp is added additively in Phase 3. */
export const SUPPRESSION_CHANNELS = ["email", "call"] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];

/** What a row records. CHECK-constrained in migration 0028. */
export const SUPPRESSION_ACTIONS = ["suppress", "correct"] as const;
export type SuppressionAction = (typeof SUPPRESSION_ACTIONS)[number];

/** Normalises a value for storage/comparison (emails case-fold). */
export function normaliseSuppressionValue(channel: SuppressionChannel, value: string): string {
  const trimmed = value.trim();
  return channel === "email" ? trimmed.toLowerCase() : trimmed;
}

/** One value's current standing, and how it got there. */
export interface SuppressionState {
  channel: SuppressionChannel;
  value: string;
  suppressed: boolean;
  /** When the newest event happened. */
  since: Date;
  reason: string | null;
  actorUserId: string | null;
}

/**
 * Records a do-not-contact request.
 *
 * ⚠️ IDEMPOTENT, BUT NO LONGER BY THE DATABASE. The unique key on
 * (org, channel, value) went with 0028 — it could not survive corrections —
 * so this reads the current state and writes nothing when the value is already
 * suppressed. Two identical `suppress` rows would be harmless (the newest still
 * says `suppress`); one row is simply tidier and keeps the old guarantee.
 *
 * ⚠️ AND THIS IS WHY IT MUST WRITE AFTER A CORRECTION. Somebody suppressed by
 * mistake, corrected, then genuinely asking six months later gets a NEW
 * `suppress` row that supersedes the correction. The old code's
 * `upsert(update: {})` would have done nothing at all here and left the stale
 * correction winning — a real request that silently failed.
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
  if (await isSuppressed(tx, input.organisationId, input.channel, value)) return;

  await tx.suppressionEvent.create({
    data: {
      organisationId: input.organisationId,
      action: "suppress",
      channel: input.channel,
      value,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
    },
  });
}

/**
 * Records that a do-not-contact was entered in error, superseding it.
 *
 * ⚠️ THIS DOES NOT DELETE ANYTHING AND CANNOT. The entry it supersedes stays in
 * the log forever, so the trail still shows the request was made, when, and by
 * whom — and that somebody later said it was a mistake, when, and why. That is
 * the difference between correcting a record and rewriting one.
 *
 * ⚠️ THE REASON IS REQUIRED HERE AND AT THE DATABASE. Undoing somebody's
 * do-not-contact is the one action in this module that has to be answerable for
 * afterwards, and a CHECK constraint keeps that true for callers that are not
 * this function.
 *
 * Returns false when the value is not currently suppressed — correcting
 * something that is already corrected is a no-op, not an error, so a
 * double-submitted form cannot stack two corrections.
 */
export async function correctSuppression(
  tx: TenantTx,
  input: {
    organisationId: string;
    channel: SuppressionChannel;
    value: string;
    reason: string;
    createdBy?: string;
  },
): Promise<boolean> {
  const value = normaliseSuppressionValue(input.channel, input.value);
  if (!(await isSuppressed(tx, input.organisationId, input.channel, value))) return false;

  await tx.suppressionEvent.create({
    data: {
      organisationId: input.organisationId,
      action: "correct",
      channel: input.channel,
      value,
      reason: input.reason,
      createdBy: input.createdBy ?? null,
    },
  });
  return true;
}

/** True when the value may not be contacted on the channel in this org. */
export async function isSuppressed(
  tx: TenantTx,
  organisationId: string,
  channel: SuppressionChannel,
  value: string,
): Promise<boolean> {
  const newest = await tx.suppressionEvent.findFirst({
    where: {
      organisationId,
      channel,
      value: normaliseSuppressionValue(channel, value),
    },
    // ⚠️ `id` BREAKS THE TIE, AND IT IS NOT DECORATION. Two events on one value
    // inside the same millisecond would otherwise order arbitrarily, and the
    // arbitrary answer here is "contact somebody who asked us not to".
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { action: true },
  });
  return newest?.action === "suppress";
}

/**
 * Which of these values are suppressed on this channel — one query, whatever
 * the length of the list.
 *
 * ⚠️ THIS EXISTS SO THE INVOICE BOOK CANNOT DRIFT FROM THE SEND PATH. It used
 * to run its own `findMany` over the table, which was correct while a row meant
 * "suppressed" and became wrong the moment corrections existed: the book would
 * have said "suppressed" on rows Eva was perfectly willing to chase. One
 * decision, one place.
 */
export async function suppressedValues(
  tx: TenantTx,
  organisationId: string,
  channel: SuppressionChannel,
  values: readonly string[],
): Promise<Set<string>> {
  const normalised = [...new Set(values.map((value) => normaliseSuppressionValue(channel, value)))];
  if (normalised.length === 0) return new Set();

  const events = await tx.suppressionEvent.findMany({
    where: { organisationId, channel, value: { in: normalised } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { value: true, action: true },
  });

  // Newest-first, so the first sighting of each value is its current state.
  const decided = new Map<string, string>();
  for (const event of events) {
    if (!decided.has(event.value)) decided.set(event.value, event.action);
  }
  return new Set(
    [...decided].filter(([, action]) => action === "suppress").map(([value]) => value),
  );
}

/**
 * Everyone this organisation is not contacting, newest first — the screen's
 * data.
 *
 * ⚠️ CURRENT STATE, NOT HISTORY. Corrected values are left out entirely rather
 * than listed as struck through: this screen answers "who will Eva not
 * contact", and a list that mixes live entries with undone ones is a list
 * somebody has to interpret before they can trust it. The undone rows are still
 * in the table and in `audit_logs` for anyone asking what happened.
 */
export async function listSuppressed(
  tx: TenantTx,
  organisationId: string,
): Promise<SuppressionState[]> {
  const events = await tx.suppressionEvent.findMany({
    where: { organisationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      channel: true,
      value: true,
      action: true,
      reason: true,
      createdAt: true,
      createdBy: true,
    },
  });

  const newest = new Map<string, SuppressionState>();
  for (const event of events) {
    const key = `${event.channel} ${event.value}`;
    if (newest.has(key)) continue;
    newest.set(key, {
      channel: event.channel as SuppressionChannel,
      value: event.value,
      suppressed: event.action === "suppress",
      since: event.createdAt,
      reason: event.reason,
      actorUserId: event.createdBy,
    });
  }

  return [...newest.values()].filter((entry) => entry.suppressed);
}
