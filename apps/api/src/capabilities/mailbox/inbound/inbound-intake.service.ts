import { Inject, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withInboundAddress } from "@eva/database";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
import type { TenantTx } from "../../../platform/permissions/permissions.js";
import { createLeadFromEmail } from "../../../platform/leads/lead-from-email.js";
import { RECEIVED_MAIL, type InboundWebhookPayload, type ReceivedMail } from "./received-mail.js";

/**
 * What happens to a message between the door and the book (Slice 3.1b).
 *
 * ⚠️ THE ORDER IS THE DESIGN, AND IT IS NOT THE OBVIOUS ONE.
 *
 *   1. resolve the address to an organisation
 *   2. WRITE THE DELIVERY DOWN
 *   3. fetch the message itself (a second network call)
 *   4. store the body, make the lead, mark it converted
 *
 * Step 2 comes before step 3 because Resend's webhook carries metadata only —
 * the body and headers need a separate call that can fail on its own, after we
 * have already answered the webhook. And the forwarded copy is THE ONLY COPY:
 * the enquiry was sent to the customer's mailbox and forwarded to us, so there
 * is nowhere to go back and re-read it from. A failure between 3 and 4 with
 * nothing written at 2 is an enquiry that never existed anywhere.
 *
 * ⚠️ A FRONT DOOR THAT DROPS WHAT IT CANNOT PARSE IS THE SAME DEFECT AS
 * REPLYING TO SPAM, POINTING THE OTHER WAY.
 */

/** What the caller turns into an HTTP status. */
export type IntakeOutcome =
  /** A lead exists. */
  | { status: "converted"; leadId: string }
  /** Seen before; nothing more to do. Webhooks retry, and this is the answer. */
  | { status: "duplicate" }
  /** Recorded, deliberately not converted. `reason` says why. */
  | { status: "ignored"; reason: string }
  /** Not one of ours — no organisation owns this address. */
  | { status: "unroutable" }
  /** Not an event we act on. */
  | { status: "not-applicable" };

/** The product an inbound enquiry belongs to. */
const LEAD_EMAIL_MODULE = "lead_follow_up_email";

@Injectable()
export class InboundIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIVED_MAIL) private readonly receivedMail: ReceivedMail,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InboundIntakeService.name);
  }

  async receive(payload: InboundWebhookPayload): Promise<IntakeOutcome> {
    if (payload.type !== "email.received") return { status: "not-applicable" };

    const deliveredTo = firstAddress(payload.data.received_for ?? payload.data.to);
    const providerMessageId = payload.data.email_id;
    if (!deliveredTo || !providerMessageId) {
      this.logger.warn(
        { providerMessageId: providerMessageId ?? null },
        "inbound webhook carried no deliverable address",
      );
      return { status: "unroutable" };
    }

    const organisationId = await this.organisationFor(deliveredTo);
    if (!organisationId) {
      /**
       * ⚠️ LOGGED AND COUNTED, NOT STORED, AND THAT IS NOT A SILENT DROP.
       * Mail to an address nobody was issued is not somebody's enquiry going
       * missing — there IS no somebody. It is a typo or a spam sweep of our
       * domain, and there is no tenant to file it under: `inbound_messages`
       * carries a NOT NULL `organisation_id` precisely so a row cannot exist
       * outside a customer's own data. Keeping arbitrary internet mail in a
       * table nobody owns would be a liability, not a feature. The log line and
       * the 3.0c metric are how a genuine routing fault shows up.
       */
      this.logger.warn({ deliveredTo }, "inbound mail arrived for an address we do not know");
      return { status: "unroutable" };
    }

    const receivedAt = parseMoment(payload.data.created_at);

    // (2) Written down before anything can fail.
    const record = await this.recordDelivery(organisationId, {
      providerMessageId,
      deliveredTo,
      from: payload.data.from ?? "",
      subject: payload.data.subject ?? null,
      rfcMessageId: payload.data.message_id ?? null,
      receivedAt,
    });
    if (record.alreadySettled) return { status: "duplicate" };

    if (!record.entitled) {
      /**
       * The address outlives the entitlement: a customer can stop paying for
       * Lead Follow-up by Email while their address is still printed on their
       * website. The mail is kept — it is theirs — but no lead is made for a
       * product nobody holds.
       */
      await this.settle(organisationId, record.id, {
        status: "ignored",
        failureReason: "organisation does not hold lead_follow_up_email",
      });
      return { status: "ignored", reason: "not-entitled" };
    }

    // (3) The message itself. Outside any transaction — a network call must
    // never be made with a database transaction held open.
    let message;
    try {
      message = await this.receivedMail.fetch(providerMessageId);
    } catch (error) {
      await this.settle(organisationId, record.id, {
        status: "failed",
        failureReason: describe(error),
      });
      /**
       * ⚠️ RETHROWN SO THE WEBHOOK ANSWERS 5xx AND RESEND TRIES AGAIN. The row
       * is already saved with what went wrong, so a retry RESUMES rather than
       * duplicates — `recordDelivery` only calls a message settled when it is
       * converted or ignored. Swallowing this would turn a transient network
       * blip into a permanently lost enquiry that looks handled.
       */
      throw error;
    }

    // (4) Body, lead and evidence, in one transaction.
    try {
      const leadId = await this.convert(organisationId, record.id, {
        providerMessageId,
        deliveredTo,
        // The fetched `From` is the authority; the webhook's is a summary.
        from: message.from || payload.data.from || "",
        subject: message.subject ?? payload.data.subject ?? null,
        text: message.text,
        html: message.html,
        headers: message.headers,
        receivedAt,
      });
      return { status: "converted", leadId };
    } catch (error) {
      await this.settle(organisationId, record.id, {
        status: "failed",
        failureReason: describe(error),
      });
      throw error;
    }
  }

  /**
   * Address → organisation, with no tenant declared. The only read in the
   * system that runs this way; migration 0029's `inbound_address_routing`
   * policy is what allows it, and allows nothing else.
   */
  private async organisationFor(address: string): Promise<string | null> {
    const normalised = address.trim().toLowerCase();
    const row = await withInboundAddress(this.prisma.db, normalised, (tx) =>
      tx.inboundAddress.findFirst({ select: { organisationId: true } }),
    );
    return row?.organisationId ?? null;
  }

  /**
   * Write the delivery down, or find the one already there.
   *
   * ⚠️ `alreadySettled` IS NOT `alreadySeen`, AND THE DIFFERENCE IS WHAT MAKES
   * RETRIES WORK. A row in `received` or `failed` is unfinished business: the
   * fetch never completed, or the conversion threw. Treating any existing row
   * as done would mean the first transient failure silently ended that
   * enquiry's life — the webhook would retry, we would say "seen it", and
   * nobody would ever get a lead.
   */
  private async recordDelivery(
    organisationId: string,
    delivery: {
      providerMessageId: string;
      deliveredTo: string;
      from: string;
      subject: string | null;
      rfcMessageId: string | null;
      receivedAt: Date;
    },
  ): Promise<{ id: string; alreadySettled: boolean; entitled: boolean }> {
    return this.inTenant(organisationId, async (tx) => {
      const entitled =
        (await tx.organisationModule.count({
          where: { moduleKey: LEAD_EMAIL_MODULE, enabled: true, deletedAt: null },
        })) > 0;

      const existing = await tx.inboundMessage.findFirst({
        where: { provider: "resend", providerMessageId: delivery.providerMessageId },
        select: { id: true, status: true },
      });
      if (existing) {
        return {
          id: existing.id,
          alreadySettled: existing.status === "converted" || existing.status === "ignored",
          entitled,
        };
      }

      const address = await tx.inboundAddress.findFirst({
        where: { address: delivery.deliveredTo, deletedAt: null },
        select: { id: true },
      });
      if (!address) {
        // Resolved a moment ago and gone now — revoked between the two reads.
        throw new Error(`Address '${delivery.deliveredTo}' is no longer live`);
      }

      const row = await tx.inboundMessage.create({
        data: {
          organisationId,
          inboundAddressId: address.id,
          provider: "resend",
          providerMessageId: delivery.providerMessageId,
          rfcMessageId: delivery.rfcMessageId,
          fromAddress: delivery.from,
          deliveredTo: delivery.deliveredTo,
          subject: delivery.subject,
          receivedAt: delivery.receivedAt,
          status: "received",
        },
        select: { id: true },
      });
      return { id: row.id, alreadySettled: false, entitled };
    });
  }

  /** Body in, lead out, delivery marked converted — one transaction. */
  private async convert(
    organisationId: string,
    messageId: string,
    message: {
      providerMessageId: string;
      deliveredTo: string;
      from: string;
      subject: string | null;
      text: string | null;
      html: string | null;
      headers: Record<string, string>;
      receivedAt: Date;
    },
  ): Promise<string> {
    return this.inTenant(organisationId, async (tx) => {
      const lead = await createLeadFromEmail(tx, organisationId, {
        from: message.from,
        deliveredTo: message.deliveredTo,
        subject: message.subject,
        text: message.text,
        providerMessageId: message.providerMessageId,
        receivedAt: message.receivedAt,
      });

      await tx.inboundMessage.update({
        where: { id: messageId },
        data: {
          fromAddress: message.from,
          subject: message.subject,
          textBody: message.text,
          htmlBody: message.html,
          headers: message.headers,
          status: "converted",
          failureReason: null,
          leadId: lead.id,
        },
      });
      return lead.id;
    });
  }

  /** Mark a delivery finished-with, one way or the other. */
  private async settle(
    organisationId: string,
    messageId: string,
    outcome: { status: "ignored" | "failed"; failureReason: string },
  ): Promise<void> {
    try {
      await this.inTenant(organisationId, (tx) =>
        tx.inboundMessage.update({
          where: { id: messageId },
          data: { status: outcome.status, failureReason: outcome.failureReason },
        }),
      );
    } catch (error) {
      /**
       * ⚠️ SWALLOWED, AND ONLY HERE. This runs inside a `catch` whose job is to
       * record why something failed and then rethrow the ORIGINAL fault. If
       * writing the reason down also fails, letting that second error escape
       * would replace the real cause with a bookkeeping error — the fault the
       * on-call reader needs, hidden by the fault they do not.
       */
      this.logger.error(
        { messageId, err: describe(error) },
        "could not record the outcome of an inbound message",
      );
    }
  }

  /**
   * System context: the organisation is declared, but there is no acting user
   * — the same shape the reconcile sweep uses. `set_config(..., true)` is SET
   * LOCAL: scoped to the transaction and never inherited by the next borrower
   * of a pooled connection.
   */
  private async inTenant<T>(organisationId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      return fn(rawTx as unknown as TenantTx);
    });
  }
}

/** The first usable recipient. Forwarding can name several; ours is one of them. */
function firstAddress(candidates: string[] | undefined): string | null {
  const found = candidates?.find((value) => typeof value === "string" && value.includes("@"));
  return found ? found.trim().toLowerCase() : null;
}

/**
 * When the enquiry arrived at our door.
 *
 * Falls back to now when the provider sends nothing usable — `received_at` is
 * NOT NULL and speed-to-lead has to be measured from something. A missing
 * timestamp makes an enquiry look newer than it is, which is the safe
 * direction: it shows up sooner rather than being quietly buried down the book.
 */
function parseMoment(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** A message safe to store and log: never a provider's error body. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
