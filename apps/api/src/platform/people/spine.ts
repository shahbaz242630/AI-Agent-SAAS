import type { TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { E164_SHAPE, EMAIL_SHAPE, WA_ID_SHAPE } from "./handles.js";

/**
 * The second write: a delivery becomes a person, a thread and a message
 * (slice 3.3b — the normalisers; blueprint §3.2–3.3, rulings 66, 67, 75–77).
 *
 * The raw tables stay and remain the evidence. `inbound_messages` is email to
 * its bones and `inbound_channel_messages` is WhatsApp to its bones; this is
 * the one shape every channel shares, written INSIDE the same transaction as
 * the raw row so the two can never disagree about whether a message exists.
 *
 * 🔑 THE IDENTITY RULES, IN THE ORDER THEY RUN (blueprint §3.3):
 *
 *   1. Normalise first. Callers hand this file normalised handles; it refuses
 *      anything else rather than fixing it, because a value that reaches here
 *      un-normalised is a value the CHECKs would refuse anyway.
 *   2. Look up inside the organisation only, by handle, in the caller's order
 *      — a WhatsApp id before its phone, an email on its own — and NEVER by
 *      name. Two Jane Smiths are two people; one address is one person.
 *   3. Auto-link only on proof of control. A message ARRIVED from these
 *      handles, so every one of them is the sender's — recorded as
 *      `verification = 'inbound'`, and a typed (`none`) handle that a message
 *      now arrives from is upgraded, whoever typed it (ruling 77).
 *   4. Never steal a handle. If a handle already belongs to a DIFFERENT
 *      person, it stays there and is reported back as a conflict. Repointing
 *      it silently is how two strangers become one record.
 *   5. Two organisations, one human: two rows. The transaction is
 *      tenant-scoped, so there is no cross-tenant lookup to get wrong.
 *
 * 🚨 RULING 76 IS DECIDED HERE AND ACTED ON BY THE CALLER. A thread is per
 * reply handle (per handle per number of ours, on WhatsApp). If the open
 * thread already names a live lead, the message is a message ON that lead,
 * and `workingLeadId` says so; the caller makes no second enquiry. A resolved
 * thread, or a person with no open thread, means a new thread — and a new
 * lead, which the caller creates and points the thread at.
 *
 * ⚠️ RACES ARE SETTLED BY THE INDEXES, NOT BY LOCKS. Two deliveries from a
 * new sender arriving at once both find nobody and both insert; the unique
 * on `(org, kind, value)` fails the loser's whole transaction, the webhook
 * answers 5xx, the provider retries, and the retry finds the person. The same
 * for `conversations_open_thread_key` and `messages_source_key`. A failed
 * transaction here is an ordinary outcome, and the raw row it was written
 * beside rolls back with it — which is what makes the retry resume cleanly.
 */

export type HandleKind = "email" | "phone" | "wa_id";

export interface Handle {
  kind: HandleKind;
  /** Already normalised — see `handles.ts`. Refused here otherwise. */
  value: string;
}

export type SpineChannel = "email" | "whatsapp";

export interface InboundDelivery {
  organisationId: string;
  channel: SpineChannel;
  /**
   * WhatsApp: the number of OURS the message arrived at — the 24-hour window
   * is a fact about the pair (their number, this one). Email: null; the CHECK
   * insists on both halves.
   */
  channelConnectionId: string | null;
  sender: {
    /** Their name as the channel reported it, or nothing. Never a lookup key. */
    displayName: string | null;
    /**
     * In lookup order, and THE FIRST ONE IS THE REPLY HANDLE the thread hangs
     * off: the WhatsApp id on WhatsApp, the address on email.
     */
    handles: readonly Handle[];
  };
  /** Resend's id, Meta's `wamid`, or nothing. */
  providerMessageId: string | null;
  /** Email: the RFC Message-ID a reply must quote to thread. WhatsApp: null. */
  providerThreadId: string | null;
  /** Email only — the CHECK refuses a subject on any other channel. */
  subject: string | null;
  bodyText: string | null;
  contentType: "text" | "media" | "other";
  /** The raw row this is the second write of. Unique together. */
  sourceTable: "inbound_messages" | "inbound_channel_messages";
  sourceId: string;
  /** ⚠️ THEIR CLOCK, NOT OURS — `Lead.receivedAt`'s rule. */
  occurredAt: Date;
}

export interface SpineWrite {
  personId: string;
  personCreated: boolean;
  conversationId: string;
  conversationOpened: boolean;
  messageId: string;
  /**
   * Ruling 76: the live lead this thread is already working, or null when
   * the caller must open one — because the thread is new, or names a lead
   * that has since been retired.
   */
  workingLeadId: string | null;
  /** Handles that belong to ANOTHER person and were left with them. */
  conflicts: Handle[];
}

/** Meta permits a free-form reply for 24 hours after the person's last message. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const SHAPES: Record<HandleKind, RegExp> = {
  email: EMAIL_SHAPE,
  phone: E164_SHAPE,
  wa_id: WA_ID_SHAPE,
};

interface OwnedIdentity {
  id: string;
  personId: string;
  verification: string;
}

const keyOf = (handle: Handle): string => `${handle.kind}:${handle.value}`;

/**
 * Refuses a handle the database would refuse. Thrown, not returned: a caller
 * that hands over an un-normalised value has a bug, and the transaction it is
 * in must not commit a raw row whose spine half silently never happened.
 */
function assertNormalised(handle: Handle): void {
  const shape = SHAPES[handle.kind];
  if (!shape || !shape.test(handle.value) || handle.value !== handle.value.trim()) {
    throw new Error(`'${handle.value}' is not a normalised ${handle.kind} handle`);
  }
  if (handle.kind === "email" && handle.value !== handle.value.toLowerCase()) {
    throw new Error(`'${handle.value}' is not a normalised email handle`);
  }
}

/**
 * What the person is called when nothing better is known.
 *
 * ⚠️ NEVER EMPTY — `people_display_name_check` refuses it — and never a
 * guess. The profile name the channel reported, else the address, else the
 * number: something a human would recognise the row by.
 */
function displayNameOf(displayName: string | null, handles: readonly Handle[]): string {
  const trimmed = displayName?.trim();
  if (trimmed) return trimmed;
  return (
    handles.find((h) => h.kind === "email")?.value ??
    handles.find((h) => h.kind === "phone")?.value ??
    handles[0]!.value
  );
}

/**
 * Records an inbound delivery on the spine. Call it inside the transaction
 * that writes (or has just written) the raw row.
 */
export async function recordInboundMessage(
  tx: TenantTx,
  delivery: InboundDelivery,
): Promise<SpineWrite> {
  const { organisationId, sender } = delivery;
  const handles = sender.handles;
  if (handles.length === 0) throw new Error("an inbound message needs at least one handle");
  for (const handle of handles) assertNormalised(handle);
  const replyHandle = handles[0]!;

  // ---------------------------------------------------------------- 1. who
  // Every handle's current owner, then the first one that has an owner wins.
  // Never by name: `displayName` is not consulted here.
  const owned = new Map<string, OwnedIdentity>();
  for (const handle of handles) {
    const identity = await tx.personIdentity.findFirst({
      where: { organisationId, kind: handle.kind, value: handle.value },
      select: { id: true, personId: true, verification: true },
    });
    if (identity) owned.set(keyOf(handle), identity);
  }

  let personId: string | null = null;
  for (const handle of handles) {
    const owner = owned.get(keyOf(handle));
    if (owner) {
      personId = owner.personId;
      break;
    }
  }

  let personCreated = false;
  if (!personId) {
    const person = await tx.person.create({
      data: {
        organisationId,
        displayName: displayNameOf(sender.displayName, handles),
        primaryEmail: handles.find((h) => h.kind === "email")?.value ?? null,
        primaryPhone: handles.find((h) => h.kind === "phone")?.value ?? null,
        // No acting user: a stranger wrote in, at a machine.
        createdBy: null,
      },
      select: { id: true },
    });
    personId = person.id;
    personCreated = true;
  }

  // ----------------------------------------------- 2. every handle, placed
  // Proof of control: a message arrived from ALL of these. A handle nobody
  // holds becomes the sender's, verified `inbound`; a handle the sender
  // already holds as typed is upgraded; a handle somebody ELSE holds is left
  // exactly where it is and reported.
  const conflicts: Handle[] = [];
  for (const handle of handles) {
    const owner = owned.get(keyOf(handle));
    if (!owner) {
      const created = await tx.personIdentity.create({
        data: {
          organisationId,
          personId,
          kind: handle.kind,
          value: handle.value,
          verification: "inbound",
          status: "active",
          createdBy: null,
        },
        select: { id: true, personId: true, verification: true },
      });
      owned.set(keyOf(handle), created);
    } else if (owner.personId !== personId) {
      conflicts.push(handle);
    } else if (owner.verification !== "inbound") {
      await tx.personIdentity.update({
        where: { id: owner.id },
        data: { verification: "inbound" },
      });
      owner.verification = "inbound";
    }
  }

  if (!personCreated) {
    // A person the client book typed with a phone only, now writing from an
    // email (or the reverse): fill the blank, never overwrite what is there.
    const person = await tx.person.findFirst({
      where: { id: personId },
      select: { primaryEmail: true, primaryPhone: true },
    });
    const email = handles.find((h) => h.kind === "email" && !conflicts.includes(h))?.value;
    const phone = handles.find((h) => h.kind === "phone" && !conflicts.includes(h))?.value;
    const fill: { primaryEmail?: string; primaryPhone?: string } = {};
    if (person && !person.primaryEmail && email) fill.primaryEmail = email;
    if (person && !person.primaryPhone && phone) fill.primaryPhone = phone;
    if (Object.keys(fill).length > 0) {
      await tx.person.update({ where: { id: personId }, data: fill });
    }
  }

  const replyIdentity = owned.get(keyOf(replyHandle))!;
  if (replyIdentity.personId !== personId) {
    // Unreachable by construction — the reply handle is first in lookup order,
    // so it either chose the person or was created on them. Said out loud so
    // a reordering that breaks the invariant fails here, not in a CHECK.
    throw new Error("the reply handle resolved to a different person from the thread");
  }

  // ------------------------------------------------------------ 3. the thread
  const replyWindowExpiresAt =
    delivery.channel === "whatsapp"
      ? new Date(delivery.occurredAt.getTime() + REPLY_WINDOW_MS)
      : null;

  const open = await tx.conversation.findFirst({
    where: {
      organisationId,
      personIdentityId: replyIdentity.id,
      channelConnectionId: delivery.channelConnectionId,
      status: "open",
    },
    select: { id: true, leadId: true, lastInboundAt: true },
  });

  let conversationId: string;
  let conversationOpened = false;
  let workingLeadId: string | null = null;

  if (open) {
    conversationId = open.id;
    // Their newest message moves the clocks; a retry of an older one does not.
    if (!open.lastInboundAt || delivery.occurredAt.getTime() >= open.lastInboundAt.getTime()) {
      await tx.conversation.update({
        where: { id: open.id },
        data: { lastInboundAt: delivery.occurredAt, replyWindowExpiresAt },
      });
    }
    if (open.leadId) {
      const lead = await tx.lead.findFirst({
        where: { id: open.leadId, deletedAt: null },
        select: { id: true },
      });
      workingLeadId = lead?.id ?? null;
    }
  } else {
    const created = await tx.conversation.create({
      data: {
        organisationId,
        personId,
        personIdentityId: replyIdentity.id,
        channel: delivery.channel,
        channelConnectionId: delivery.channelConnectionId,
        status: "open",
        providerThreadId: delivery.providerThreadId,
        lastInboundAt: delivery.occurredAt,
        replyWindowExpiresAt,
        createdBy: null,
      },
      select: { id: true },
    });
    conversationId = created.id;
    conversationOpened = true;
  }

  // ----------------------------------------------------------- 4. the message
  // `(source_table, source_id)` is unique: the second write of the same raw
  // row is the row that is already there.
  const already = await tx.message.findFirst({
    where: { sourceTable: delivery.sourceTable, sourceId: delivery.sourceId },
    select: { id: true },
  });
  const messageId =
    already?.id ??
    (
      await tx.message.create({
        data: {
          organisationId,
          conversationId,
          personId,
          channel: delivery.channel,
          direction: "inbound",
          senderKind: "person",
          contentType: delivery.contentType,
          subject: delivery.channel === "email" ? delivery.subject : null,
          bodyText: delivery.bodyText,
          providerMessageId: delivery.providerMessageId,
          sourceTable: delivery.sourceTable,
          sourceId: delivery.sourceId,
          occurredAt: delivery.occurredAt,
        },
        select: { id: true },
      })
    ).id;

  return {
    personId,
    personCreated,
    conversationId,
    conversationOpened,
    messageId,
    workingLeadId,
    conflicts,
  };
}

/**
 * Points a thread at the enquiry it is now working (ruling 67: a repeat
 * customer gets a new lead each time and the thread is repointed).
 */
export async function attachLeadToThread(
  tx: TenantTx,
  conversationId: string,
  leadId: string,
): Promise<void> {
  await tx.conversation.update({ where: { id: conversationId }, data: { leadId } });
}

// ---------------------------------------------------------------------------
// System stages
// ---------------------------------------------------------------------------

/**
 * The eight stages automation reads (blueprint §3.2; Jobber's rule: system
 * stages drive automation, custom stages are cosmetic). Verbatim from the
 * 0041 backfill, which seeded them for every organisation that existed on
 * 2026-09-04; an organisation created since gets them on its first lead write.
 */
export const SYSTEM_STAGES = [
  { key: "new", name: "New", position: 1 },
  { key: "contacted", name: "Contacted", position: 2 },
  { key: "qualified", name: "Qualified", position: 3 },
  { key: "quoted", name: "Quoted", position: 4 },
  { key: "booked", name: "Booked", position: 5 },
  { key: "done", name: "Done", position: 6 },
  { key: "reviewed", name: "Reviewed", position: 7 },
  { key: "lost", name: "Lost", position: 8 },
] as const;

export type SystemStageKey = (typeof SYSTEM_STAGES)[number]["key"];

/**
 * The organisation's system stages by key, seeding any that are missing.
 *
 * ⚠️ SEEDED ON THE FIRST LEAD WRITE, AND THAT IS A DIFFERENT CALL FROM THE
 * TEMPLATES. `ensureDefaultTemplates` runs only when a customer opens a
 * screen, because a webhook must not write a customer's default WORDING as a
 * side effect of a stranger sending mail. Stages are not wording: they are
 * the structure every enquiry needs a place in, the backfill gave them to
 * every existing organisation unasked, and a lead with no stage is the
 * `endsAt` trap. So the precedent followed here is the "ensure on first
 * write" shape, not the "ensure on first look" trigger.
 *
 * A system stage cannot be soft-deleted (CHECK), so "has none live" and
 * "never had one" are the same question, and the seed is exactly-once by
 * construction. Under a race the partial unique on `(org, system_key)` fails
 * the loser's transaction.
 */
export async function ensureSystemStages(
  tx: TenantTx,
  organisationId: string,
): Promise<Record<SystemStageKey, string>> {
  const live = await tx.pipelineStage.findMany({
    where: { organisationId, systemKey: { not: null }, deletedAt: null },
    select: { id: true, systemKey: true },
  });
  const byKey = new Map<string, string>();
  for (const stage of live) byKey.set(stage.systemKey!, stage.id);

  const missing = SYSTEM_STAGES.filter((stage) => !byKey.has(stage.key));
  if (missing.length > 0) {
    for (const stage of missing) {
      const row = await tx.pipelineStage.create({
        data: {
          organisationId,
          systemKey: stage.key,
          name: stage.name,
          position: stage.position,
          createdBy: null,
        },
        select: { id: true },
      });
      byKey.set(stage.key, row.id);
    }
    await writeAuditLog(tx, {
      organisationId,
      actorUserId: null,
      action: "pipeline_stage.system_seeded",
      entityType: "pipeline_stage",
      metadata: { keys: missing.map((stage) => stage.key) },
    });
  }

  const stages = {} as Record<SystemStageKey, string>;
  for (const stage of SYSTEM_STAGES) stages[stage.key] = byKey.get(stage.key)!;
  return stages;
}
