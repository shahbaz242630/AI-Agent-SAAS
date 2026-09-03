import { Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withChannelAsset, type EvaPrismaClient } from "@eva/database";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
import {
  parseWhatsAppWebhook,
  WHATSAPP_WEBHOOK_OBJECT,
  type ParsedWhatsAppWebhook,
  type WhatsAppDelivery,
} from "./whatsapp-payload.js";

/**
 * What happens to a WhatsApp message between the door and the record (3.2c).
 *
 * Two steps, and this slice deliberately stops after them:
 *
 *   1. resolve the number the message arrived at → an organisation
 *   2. WRITE THE DELIVERY DOWN, idempotently
 *
 * Nothing becomes a lead here. That is 3.3, on the spine, once a delivery has
 * a person and a conversation to belong to (`docs/LEAD-360-BLUEPRINT.md` §7).
 *
 * ⚠️ WHY STEP 2 IS ALL THERE IS, AND WHY IT MUST NOT FAIL. Meta keeps no
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
}

@Injectable()
export class MetaInboundIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetaInboundIntakeService.name);
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

    // One routing lookup per number per webhook, not per message.
    const byNumber = new Map<string, WhatsAppDelivery[]>();
    for (const delivery of parsed.deliveries) {
      const key = `${delivery.wabaId}:${delivery.phoneNumberId}`;
      const list = byNumber.get(key) ?? [];
      list.push(delivery);
      byNumber.set(key, list);
    }

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
        counts[await this.record(connection, delivery)] += 1;
      }
    }

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
          select: { id: true, organisationId: true, moduleKey: true },
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
  ): Promise<"stored" | "duplicates" | "ignored"> {
    return this.inTenant(connection.organisationId, async (tx) => {
      const existing = await tx.inboundChannelMessage.findFirst({
        where: { channel: CHANNEL, providerMessageId: delivery.providerMessageId },
        select: { id: true },
      });
      if (existing) return "duplicates";

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

      try {
        await tx.inboundChannelMessage.create({
          data: {
            organisationId: connection.organisationId,
            connectionId: connection.id,
            channel: CHANNEL,
            providerMessageId: delivery.providerMessageId,
            fromIdentifier: delivery.fromIdentifier,
            fromDisplayName: delivery.fromDisplayName,
            messageType: delivery.messageType,
            textBody: delivery.textBody,
            payload: delivery.payload,
            status: entitled ? "received" : "ignored",
            failureReason: entitled ? null : `organisation does not hold ${connection.moduleKey}`,
            /**
             * Their clock when they gave us one. A message with no usable
             * timestamp is still stored — the alternative is losing it — and
             * the arrival time is the honest fallback.
             */
            receivedAt: delivery.receivedAt ?? new Date(),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return "duplicates";
        throw error;
      }
      return entitled ? "stored" : "ignored";
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

/** Prisma's code for a unique-constraint violation. Duck-typed to keep the client type out of here. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
