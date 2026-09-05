import { Inject, Injectable, Optional } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withChannelAsset, type EvaPrismaClient } from "@eva/database";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
import { createLeadFromChannelMessage } from "../../../platform/leads/lead-from-channel-message.js";
import {
  NEW_LEAD_HANDLERS,
  type NewLead,
  type NewLeadHandlers,
} from "../../../platform/leads/new-lead-handler.js";
import { normaliseWaId, phoneFromWaId } from "../../../platform/people/handles.js";
import {
  attachLeadToThread,
  ensureSystemStages,
  recordInboundMessage,
} from "../../../platform/people/spine.js";
import {
  parseWhatsAppWebhook,
  WHATSAPP_WEBHOOK_OBJECT,
  type ParsedWhatsAppWebhook,
  type WhatsAppDelivery,
} from "./whatsapp-payload.js";

/**
 * What happens to a WhatsApp message between the door and the book (3.2c,
 * then 3.3b).
 *
 *   1. resolve the number the message arrived at → an organisation
 *   2. WRITE THE DELIVERY DOWN, idempotently
 *   3. put it on the spine: the person, the thread, the canonical message
 *   4. make the lead — or find the one the thread is already working
 *      (ruling 76) — and mark the delivery converted
 *
 * Steps 2–4 are ONE transaction. 3.2c stopped after step 2; 3.3b added the
 * rest once a delivery had a person and a conversation to belong to
 * (`docs/LEAD-360-BLUEPRINT.md` §7). Only a NEW lead is announced to the
 * products, after the transaction commits — the mail door's rule.
 *
 * ⚠️ WHY STEP 2 COMES FIRST, AND WHY IT MUST NOT FAIL. Meta keeps no
 * history — there is no API for fetching past webhooks — so the row written
 * here is the only copy of what a stranger sent. And Meta retries anything
 * that is not a 200 for up to seven days, to every app subscribed to the
 * account, so the same message arriving three times is the ordinary case, not
 * the edge: the unique index on the provider's id is what turns the second and
 * third into no-ops instead of three enquiries.
 *
 * ⚠️ WHAT THE STATUS CODE MEANS TO META IS PART OF THE DESIGN — the same rule
 * as the Resend door. A 200 means "settled, never send this again". So a
 * duplicate, a message for a number nobody connected, a receipt for something
 * we sent, a shape we could not read: all 200, counted and logged. Only a
 * genuine fault is allowed to be a 5xx.
 */

const CHANNEL = "whatsapp";

/** What the controller returns; the counts are the same numbers the log carries. */
export interface ChannelIntakeOutcome {
  /**
   * `received` — at least one delivery stored;
   * `duplicate` — everything here was seen before;
   * `unroutable` — the number is not one anybody connected;
   * `ignored` — stored, but the organisation no longer holds the product;
   * `not-applicable` — nothing to store (receipts, another Meta object, or a
   *   shape we could not read).
   */
  status: "received" | "duplicate" | "unroutable" | "ignored" | "not-applicable";
  stored: number;
  duplicates: number;
  unroutable: number;
  ignored: number;
  statusUpdates: number;
  malformed: number;
}

interface RoutedConnection {
  id: string;
  organisationId: string;
  moduleKey: string;
  /** The display phone number a human knows the connection by, if recorded. */
  displayName: string | null;
}

/** What one delivery came to, and whether the products need telling. */
interface Recorded {
  outcome: "stored" | "duplicates" | "ignored";
  /** Set only when a NEW enquiry was opened — never for a message on one. */
  newLead: NewLead | null;
}

@Injectable()
export class MetaInboundIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * ⚠️ A PORT, NOT AN IMPORT — the same one the mail door announces
     * through, which is why it lives in `platform/leads/` and not in either
     * capability. This file must never name a product.
     */
    @Optional()
    @Inject(NEW_LEAD_HANDLERS)
    private readonly newLeadHandlers: NewLeadHandlers = [],
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetaInboundIntakeService.name);
  }

  /**
   * Tell everyone who cares that a lead arrived — the mail door's dispatcher,
   * with the mail door's rules: every handler isolated, run in turn, and the
   * webhook never fails for one. The enquiry is already committed by the
   * time this runs.
   */
  private async announceNewLead(lead: NewLead): Promise<void> {
    for (const handler of this.newLeadHandlers) {
      try {
        await handler.onNewLead(lead);
      } catch (error) {
        this.logger.error(
          { ...lead, err: describe(error) },
          "a new-lead handler threw; the enquiry is stored and the delivery still succeeded",
        );
      }
    }
  }

  async receive(payload: unknown): Promise<ChannelIntakeOutcome> {
    const parsed = parseWhatsAppWebhook(payload);
    const counts = {
      stored: 0,
      duplicates: 0,
      unroutable: 0,
      ignored: 0,
      statusUpdates: parsed.statusUpdates,
      malformed: parsed.malformed,
    };

    if (parsed.object !== WHATSAPP_WEBHOOK_OBJECT) {
      // Messenger and Instagram arrive on the same app with a different
      // `object`. Not ours yet; acknowledged so Meta does not retry it.
      this.logger.info(
        { object: parsed.object },
        "Meta webhook for an object we do not handle yet",
      );
      return { status: "not-applicable", ...counts };
    }
    if (parsed.malformed > 0) {
      this.logger.warn(
        { malformed: parsed.malformed },
        "Meta webhook carried messages that could not be read — acknowledged, not stored",
      );
    }
    /**
     * ⚠️ A FAILED RECEIPT IS THE ONLY WAY WE HEAR THAT A REPLY DID NOT ARRIVE
     * (3.4a). Meta accepts a send with a 200 and reports the closed window,
     * the unpaid account and the blocked number afterwards, here. Logged
     * with the code so the walk can see one; stored nowhere yet — see the
     * payload module's header for why that waits for 3.5.
     */
    for (const failed of parsed.failedStatuses) {
      this.logger.warn(
        { providerMessageId: failed.providerMessageId, code: failed.code, title: failed.title },
        "Meta reported that a message we sent was not delivered",
      );
    }

    // One routing lookup per number per webhook, not per message.
    const byNumber = new Map<string, WhatsAppDelivery[]>();
    for (const delivery of parsed.deliveries) {
      const key = `${delivery.wabaId}:${delivery.phoneNumberId}`;
      const list = byNumber.get(key) ?? [];
      list.push(delivery);
      byNumber.set(key, list);
    }

    const newLeads: NewLead[] = [];
    for (const deliveries of byNumber.values()) {
      const first = deliveries[0]!;
      const connection = await this.connectionFor(first.wabaId, first.phoneNumberId);
      if (!connection) {
        /**
         * ⚠️ LOGGED AND COUNTED, NOT STORED — the same call the mail door
         * made for an unknown address. A message to a number nobody connected
         * has no organisation to belong to, and `inbound_channel_messages`
         * carries a NOT NULL organisation precisely so a row cannot exist
         * outside a customer's own data. If a real customer's number lands
         * here, the log line is how it shows up.
         */
        counts.unroutable += deliveries.length;
        this.logger.warn(
          { wabaId: first.wabaId, phoneNumberId: first.phoneNumberId, count: deliveries.length },
          "WhatsApp messages arrived for a number nobody has connected",
        );
        continue;
      }
      for (const delivery of deliveries) {
        const { outcome, newLead } = await this.record(connection, delivery);
        counts[outcome] += 1;
        if (newLead) newLeads.push(newLead);
      }
    }

    /**
     * ⚠️ AFTER EVERY TRANSACTION HAS COMMITTED, AND THAT ORDER IS LOAD-BEARING
     * — the mail door's rule, for the same reason. The reply handler opens its
     * own transaction and reads the lead; inside `record`'s it would either
     * deadlock on the same rows or be handed a lead that might still roll
     * back, and a stranger would have been answered about an enquiry that
     * no longer exists.
     */
    for (const lead of newLeads) await this.announceNewLead(lead);

    return { status: statusOf(counts, parsed), ...counts };
  }

  /**
   * Which organisation owns this number.
   *
   * ⚠️ THE ONE READ IN THIS SYSTEM MADE WITH NO TENANT DECLARED, ON THIS
   * TABLE. Migration 0040's `channel_asset_routing` policy allows exactly this
   * lookup — one live row, by the exact `channel:account:asset` key — and
   * nothing else.
   */
  private async connectionFor(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<RoutedConnection | null> {
    return withChannelAsset(
      this.prisma.db,
      { channel: CHANNEL, externalAccountId: wabaId, externalAssetId: phoneNumberId },
      (tx) =>
        tx.channelConnection.findFirst({
          select: { id: true, organisationId: true, moduleKey: true, displayName: true },
        }),
    );
  }

  /**
   * Write the delivery down, or find the one already there.
   *
   * ⚠️ TWO DEFENCES AGAINST THE DUPLICATE, NOT ONE. The `findFirst` is the
   * cheap path; the unique index is the real one, because two retries of the
   * same message can arrive concurrently and both pass the read. A unique
   * violation on the insert is therefore an ordinary outcome, not a fault.
   */
  private async record(
    connection: RoutedConnection,
    delivery: WhatsAppDelivery,
  ): Promise<Recorded> {
    const { organisationId } = connection;
    return this.inTenant(organisationId, async (tx) => {
      const existing = await tx.inboundChannelMessage.findFirst({
        where: { channel: CHANNEL, providerMessageId: delivery.providerMessageId },
        select: { id: true },
      });
      if (existing) return { outcome: "duplicates", newLead: null };

      /**
       * The number outlives the entitlement, exactly as an inbound address
       * does: a customer can stop paying for the product while their WhatsApp
       * is still connected. The message is kept — it is theirs — but marked
       * so nothing downstream acts on it for a product nobody holds.
       */
      const entitled =
        (await tx.organisationModule.count({
          where: { moduleKey: connection.moduleKey, enabled: true, deletedAt: null },
        })) > 0;

      /**
       * The sender's two handles, from one id: WhatsApp's `wa_id` IS the E.164
       * number without its plus, so no country is guessed. An id that is not
       * a number is stored and goes no further — nothing could answer it.
       */
      const waId = normaliseWaId(delivery.fromIdentifier);
      const phone = waId ? phoneFromWaId(waId) : null;
      /**
       * Their clock when they gave us one. A message with no usable timestamp
       * is still stored — the alternative is losing it — and the arrival time
       * is the honest fallback.
       */
      const receivedAt = delivery.receivedAt ?? new Date();

      /** Why the delivery is kept but goes no further, or null when it becomes an enquiry. */
      const held: { status: "ignored" | "failed"; reason: string } | null = !entitled
        ? { status: "ignored", reason: `organisation does not hold ${connection.moduleKey}` }
        : !waId || !phone
          ? {
              status: "failed",
              reason: "the sender id is not a WhatsApp number, so nothing could answer it",
            }
          : null;

      let row: { id: string };
      try {
        row = await tx.inboundChannelMessage.create({
          data: {
            organisationId,
            connectionId: connection.id,
            channel: CHANNEL,
            providerMessageId: delivery.providerMessageId,
            fromIdentifier: delivery.fromIdentifier,
            fromDisplayName: delivery.fromDisplayName,
            messageType: delivery.messageType,
            textBody: delivery.textBody,
            payload: delivery.payload,
            status: held?.status ?? "received",
            failureReason: held?.reason ?? null,
            receivedAt,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { outcome: "duplicates", newLead: null };
        throw error;
      }

      if (held) {
        if (held.status === "failed") {
          // The reason, never the id: this is a stranger's identifier.
          this.logger.warn(
            { organisationId, providerMessageId: delivery.providerMessageId },
            "a WhatsApp message arrived from an id that is not a number; stored, not converted",
          );
        }
        return { outcome: held.status === "ignored" ? "ignored" : "stored", newLead: null };
      }

      // (3) The spine: who, which thread, the canonical message.
      const spine = await recordInboundMessage(tx, {
        organisationId,
        channel: CHANNEL,
        channelConnectionId: connection.id,
        sender: {
          displayName: delivery.fromDisplayName,
          // The WhatsApp id first: it is the reply handle the thread hangs off.
          handles: [
            { kind: "wa_id", value: waId! },
            { kind: "phone", value: phone! },
          ],
        },
        providerMessageId: delivery.providerMessageId,
        providerThreadId: null,
        subject: null,
        bodyText: delivery.textBody,
        contentType: contentTypeOf(delivery.messageType),
        sourceTable: "inbound_channel_messages",
        sourceId: row.id,
        occurredAt: receivedAt,
      });
      if (spine.conflicts.length > 0) {
        // Kinds only — the values are a stranger's number.
        this.logger.warn(
          { organisationId, personId: spine.personId, kinds: spine.conflicts.map((h) => h.kind) },
          "a handle on this message already belongs to another person and was left with them",
        );
      }

      /**
       * (4) The enquiry — ruling 76. A thread already working a live lead
       * files the message on it; otherwise this message opens one and the
       * thread points at it.
       */
      let leadId: string;
      let newLead: NewLead | null = null;
      if (spine.workingLeadId) {
        leadId = spine.workingLeadId;
      } else {
        const stages = await ensureSystemStages(tx, organisationId);
        const lead = await createLeadFromChannelMessage(
          tx,
          organisationId,
          {
            displayName: delivery.fromDisplayName,
            phone: phone!,
            text: delivery.textBody,
            providerMessageId: delivery.providerMessageId,
            deliveredTo: deliveredTo(connection, delivery),
            receivedAt,
          },
          {
            personId: spine.personId,
            pipelineStageId: stages.new,
            originConversationId: spine.conversationId,
          },
        );
        await attachLeadToThread(tx, spine.conversationId, lead.id);
        leadId = lead.id;
        newLead = { organisationId, leadId: lead.id };
      }

      await tx.inboundChannelMessage.update({
        where: { id: row.id },
        data: { status: "converted", leadId },
      });
      return { outcome: "stored", newLead };
    });
  }

  private async inTenant<T>(
    organisationId: string,
    fn: (tx: EvaPrismaClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      return fn(rawTx as unknown as EvaPrismaClient);
    });
  }
}

function statusOf(
  counts: { stored: number; duplicates: number; unroutable: number; ignored: number },
  parsed: ParsedWhatsAppWebhook,
): ChannelIntakeOutcome["status"] {
  if (counts.stored > 0) return "received";
  if (counts.duplicates > 0) return "duplicate";
  if (counts.unroutable > 0) return "unroutable";
  if (counts.ignored > 0) return "ignored";
  void parsed;
  return "not-applicable";
}

/**
 * What a message IS, for the timeline. Mirrors the 0041 backfill's case
 * statement so a message that arrived yesterday and one arriving today read
 * the same.
 */
function contentTypeOf(messageType: string): "text" | "media" | "other" {
  if (messageType === "text") return "text";
  if (["image", "audio", "video", "document", "sticker"].includes(messageType)) return "media";
  return "other";
}

/**
 * The number of OURS the message came to, as a human would recognise it: the
 * display number Meta named in the webhook, else the one recorded on the
 * connection, else the phone number id — never nothing, because the
 * evidence's "sent to" is half of the claim.
 */
function deliveredTo(connection: RoutedConnection, delivery: WhatsAppDelivery): string {
  const display = delivery.displayPhoneNumber ? phoneFromWaId(delivery.displayPhoneNumber) : null;
  return display ?? connection.displayName ?? delivery.phoneNumberId;
}

/** A message safe to store and log: never a provider's error body. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}

/** Prisma's code for a unique-constraint violation. Duck-typed to keep the client type out of here. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
