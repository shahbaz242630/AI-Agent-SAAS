import { Inject, Injectable } from "@nestjs/common";
import { replyChannelForLeadSource, type ReplyChannel } from "@eva/types";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "../../../capabilities/mailbox/mailboxes.service.js";
import type { SendingMailboxResolution } from "../../../capabilities/mailbox/mailboxes.service.js";
import {
  MailboxUnusableError,
  MailDeliveryDeferredError,
  OUTBOUND_MAIL,
  type OutboundMail,
} from "../../../capabilities/mailbox/outbound-mail.js";
import { forwardingOf } from "../../../capabilities/messaging/meta/whatsapp-payload.js";
import {
  ChannelUnusableError,
  MessageDeliveryDeferredError,
  MessageDeliveryError,
  OUTBOUND_MESSAGE,
  type OutboundMessage,
} from "../../../capabilities/messaging/outbound-message.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WhatsAppNumbersService } from "../../../capabilities/messaging/whatsapp-numbers.service.js";
import type { SendingNumberResolution } from "../../../capabilities/messaging/whatsapp-numbers.service.js";
import { phoneFromWaId } from "../../../platform/people/handles.js";
import type { TenantTx } from "../../../platform/permissions/permissions.js";
import { recordOutboundMessage } from "../../../platform/people/spine.js";
import {
  REPLY_DECISION_PROVIDER,
  type ReplyDecision,
  type ReplyDecisionInput,
  type ReplyDecisionProvider,
} from "../decision/reply-decision.js";
import { composeReply, composeWhatsAppReply } from "./compose-reply.js";

/**
 * Answering one enquiry (slice 3.1c-3; WhatsApp since 3.4a) — the half of the
 * product the catalogue blurb has been promising since 3.1a.
 *
 * ⚠️ CLAIM, SEND, SETTLE — AND THE ORDER IS THE IDEMPOTENCY. The decision row
 * is written FIRST, inside a transaction, as `pending`. That INSERT is what
 * claims the lead: `lead_reply_decisions_one_per_lead_key` is unique per live
 * lead, so a second attempt loses the race and stops. Only then does the send
 * happen, outside any transaction, and the row is settled afterwards.
 *
 * Sending first and recording after would mean a crash between the two sends a
 * stranger a message with no record that it happened. Recording inside the send
 * transaction is not an option either: `RoutedOutboundMail` refreshes the OAuth
 * token before every send and does so deliberately outside the caller's
 * transaction, because the provider has already rotated the pair by the time it
 * returns.
 *
 * ⚠️ RESEND AND META BOTH RETRY A WEBHOOK THAT DOES NOT ANSWER 200 — Resend
 * "immediately, then a few more times over the next 36 hours", Meta for up to
 * seven days. Intake is already idempotent on the provider's message id; this
 * is the second effect and needs its own guard, or a retried delivery sends the
 * same automatic reply twice in the customer's name.
 *
 * 🔑 THE CHANNEL IS DECIDED FIRST AND EVERYTHING AFTER IT IS PER CHANNEL
 * (3.4a). What the two paths share is the shape — decide, find the wording,
 * find somewhere to send from, compose, claim, send, settle — and the record.
 * What they do not share is a single line of provider code: email resolves a
 * mailbox and composes a subject; WhatsApp reads the enquiry's thread for the
 * handle, the number and the 24-hour window. A `switch` with no default keeps
 * a third channel a compile error rather than a silent email.
 */
@Injectable()
export class LeadReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailboxes: MailboxesService,
    private readonly numbers: WhatsAppNumbersService,
    @Inject(OUTBOUND_MAIL) private readonly outboundMail: OutboundMail,
    @Inject(OUTBOUND_MESSAGE) private readonly outboundMessages: OutboundMessage,
    @Inject(REPLY_DECISION_PROVIDER) private readonly decisions: ReplyDecisionProvider,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LeadReplyService.name);
  }

  /**
   * Decide about a lead and, if it deserves one, answer it.
   *
   * ⚠️ NEVER THROWS FOR A BUSINESS OUTCOME. Every refusal, every missing
   * mailbox and every provider failure ends as a recorded row and a returned
   * status. The only exceptions that escape are genuine faults, because the
   * caller is a webhook that has already stored the enquiry — and losing an
   * enquiry because Eva could not answer it would be far worse than not
   * answering.
   */
  async answer(organisationId: string, leadId: string): Promise<ReplyOutcome> {
    const claim = await this.claim(organisationId, leadId);
    if (claim.kind !== "send") return claim.outcome;

    /**
     * ⚠️ OUTSIDE THE TRANSACTION, AND THAT IS NOT AN OPTIMISATION. The token
     * refresh inside `deliver` commits on its own; holding a transaction open
     * across a provider round trip is what timed out on transatlantic latency
     * in slice 1.5 (PR #36).
     */
    let sent: Sent;
    try {
      sent = await this.send(organisationId, claim.delivery);
    } catch (error) {
      return await this.settleFailure(
        organisationId,
        claim.decisionId,
        leadId,
        claim.delivery.channel,
        error,
      );
    }

    await this.settleSent(organisationId, claim.decisionId, leadId, sent);
    this.logger.info(
      { organisationId, leadId, channel: claim.delivery.channel },
      "replied to an enquiry",
    );
    return { status: "sent" };
  }

  /** The provider round trip, per channel. Throws the port's own errors. */
  private async send(organisationId: string, delivery: PreparedDelivery): Promise<Sent> {
    switch (delivery.channel) {
      case "email": {
        await this.outboundMail.deliver({
          organisationId,
          account: delivery.account,
          actorUserId: delivery.actorUserId,
          to: delivery.to,
          subject: delivery.subject,
          bodyText: delivery.bodyText,
        });
        return {
          to: delivery.to,
          subject: delivery.subject,
          body: delivery.bodyText,
          from: delivery.account.emailAddress,
          providerMessageId: null,
        };
      }
      case "whatsapp": {
        const receipt = await this.outboundMessages.deliver({
          organisationId,
          connection: {
            id: delivery.number.connection.id,
            phoneNumberId: delivery.number.connection.phoneNumberId,
          },
          to: delivery.toWaId,
          bodyText: delivery.bodyText,
          replyToProviderMessageId: delivery.replyToProviderMessageId,
        });
        return {
          /**
           * ⚠️ E.164 WITH THE PLUS, NOT THE BARE `wa_id` — 0039 said this
           * column "holds an E.164 phone number" once WhatsApp landed, and
           * the person's phone handle is exactly that.
           */
          to: phoneFromWaId(delivery.toWaId) ?? `+${delivery.toWaId}`,
          subject: null,
          body: delivery.bodyText,
          from: delivery.number.connection.displayName ?? delivery.number.connection.phoneNumberId,
          providerMessageId: receipt.providerMessageId,
        };
      }
    }
  }

  /**
   * Everything that happens in one transaction: read the lead, decide, and
   * write the row that claims it.
   */
  private async claim(organisationId: string, leadId: string): Promise<Claim> {
    return await this.inTenant(organisationId, async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null },
        include: {
          /** The email delivery it came from — where the headers the rules read live. */
          inboundMessages: { orderBy: { receivedAt: "desc" }, take: 1 },
          /** The WhatsApp delivery it came from — the type and Meta's flags. */
          inboundChannelMessages: { orderBy: { receivedAt: "desc" }, take: 1 },
          /** The provider id of the message being answered, for the quote. */
          evidence: { select: { externalId: true } },
        },
      });
      if (!lead) return { kind: "done", outcome: { status: "skipped", reason: "lead not found" } };

      /**
       * ⚠️ ALREADY DECIDED IS A NORMAL OUTCOME, NOT AN ERROR. A Resend retry
       * lands here, and so does a manual re-run. Checking first turns the
       * common case into a read rather than a caught constraint violation.
       */
      const existing = await tx.leadReplyDecision.findFirst({
        where: { leadId, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        return { kind: "done", outcome: { status: "skipped", reason: "already decided" } };
      }

      /**
       * 🚨 WHICH MEDIUM TO ANSWER ON, DECIDED BEFORE ANYTHING ELSE (slice 3.2b).
       *
       * ⚠️ A NULL IS NOT A FAULT AND MUST NOT FALL BACK TO EMAIL. It means the
       * lead arrived by a route this code does not understand — and guessing
       * email there would have Eva reply by email to somebody who messaged on
       * another channel, at an address the lead may not even carry, in the
       * customer's name. Recorded and left alone is the ruling 32 answer.
       *
       * The three retired call-shaped sources land here; so would a channel a
       * later door writes before the map learns it.
       */
      const channel = replyChannelForLeadSource(lead.source);
      if (!channel) {
        await tx.leadReplyDecision.create({
          data: {
            organisationId,
            leadId,
            /**
             * ⚠️ NULL, NOT `"email"`. Writing a channel we did not determine
             * would falsify the one record of what a stranger did or did not
             * receive. Migration 0039 makes this column nullable for exactly
             * this row, and refuses to let a null-channel row claim it sent
             * anything.
             */
            channel: null,
            verdict: "hold",
            reason: "this enquiry arrived by a route Eva cannot reply on yet",
            signal: "unmapped_lead_source",
            status: "not_sent",
          },
        });
        return { kind: "done", outcome: { status: "not_sent", verdict: "hold" } };
      }

      const decision = this.decisions.decide(decisionInputFor(channel, lead));

      /** A refusal or a hold: record it and stop. Nothing went wrong. */
      if (decision.verdict !== "reply") {
        await tx.leadReplyDecision.create({
          data: {
            organisationId,
            leadId,
            channel,
            verdict: decision.verdict,
            reason: decision.reason,
            signal: decision.signal,
            status: "not_sent",
          },
        });
        return { kind: "done", outcome: { status: "not_sent", verdict: decision.verdict } };
      }

      /**
       * ⚠️ THE AUTOMATIC TEMPLATE IS NOT SEEDED HERE. `ensureDefaultTemplates`
       * runs on the templates endpoint, which is a customer opening a screen —
       * a person, with a permission, in a request that is allowed to write. A
       * webhook creating a customer's default wording as a side effect of a
       * stranger sending mail is a write nobody asked for, and it would seed
       * them for an organisation that never opened the product.
       *
       * So no automatic template means no reply, said plainly. The screen
       * already warns about exactly this state in red.
       */
      /**
       * ⚠️ SCOPED TO THE CHANNEL (slice 3.2b). Unscoped, an enquiry on one
       * medium would be answered with the wording written for another — the
       * email default tells the reader to "reply to this email", which is
       * nonsense sent over WhatsApp, and it would go out unread in the
       * customer's name.
       */
      const template = await tx.leadReplyTemplate.findFirst({
        where: { channel, isAutomatic: true, deletedAt: null },
        select: { id: true, body: true },
      });
      if (!template) {
        return await this.recordUnsendable(tx, organisationId, leadId, channel, decision, {
          reason: "no automatic reply is switched on, so nothing was sent",
        });
      }

      switch (channel) {
        case "email":
          return await this.prepareEmail(tx, organisationId, lead, template, decision);
        case "whatsapp":
          return await this.prepareWhatsApp(tx, organisationId, lead, template, decision);
      }
    });
  }

  /** Compose the email, find the mailbox, write the claim. Unchanged from 3.1c-3. */
  private async prepareEmail(
    tx: TenantTx,
    organisationId: string,
    lead: LeadToAnswer,
    template: { id: string; body: string },
    decision: ReplyDecision,
  ): Promise<Claim> {
    const message = lead.inboundMessages[0];
    const composed = composeReply(
      { contactEmail: lead.contactEmail ?? "", originalSubject: message?.subject ?? null },
      template.body,
    );
    if (!composed.composed) {
      return await this.recordUnsendable(tx, organisationId, lead.id, "email", decision, {
        reason: composed.reason,
        templateId: template.id,
      });
    }

    /**
     * ⚠️ RULING 51 — LEAD FOLLOW-UP IGNORES THE PER-CLIENT MAILBOX FILING,
     * AND IT NEEDS NO BRANCH TO DO SO. `emailAccountId: null` asks for the
     * product's own default. A client filed against Invoice Chasing's mailbox
     * cannot be picked anyway, because the candidate list is product-scoped —
     * but asking for the default states the intent rather than relying on it.
     */
    const resolution = await this.mailboxes.resolveSendingMailbox(
      tx,
      organisationId,
      "lead_follow_up",
      { organisationId, emailAccountId: null },
    );
    if (!resolution) {
      return await this.recordUnsendable(tx, organisationId, lead.id, "email", decision, {
        reason: "no mailbox is connected for Lead Follow-up, so nothing was sent",
        templateId: template.id,
      });
    }

    const row = await this.writeClaim(tx, organisationId, lead.id, "email", decision, template.id);
    return {
      kind: "send",
      decisionId: row.id,
      delivery: {
        channel: "email",
        to: composed.reply.to,
        subject: composed.reply.subject,
        bodyText: composed.reply.bodyText,
        account: resolution.account,
        /**
         * Whose grant this is. `connectedBy` is the person who authorised the
         * mailbox; a refresh happens under their consent, not a stranger's.
         */
        actorUserId: resolution.account.connectedBy ?? "",
      },
    };
  }

  /**
   * Read the thread, check the window, find the number, write the claim
   * (slice 3.4a).
   *
   * 🔑 THE THREAD IS THE SOURCE OF EVERYTHING A WHATSAPP REPLY NEEDS. The
   * enquiry's origin conversation (3.3b) hangs off the person's `wa_id`
   * identity — the reply handle — and carries the number of ours it arrived
   * at and `reply_window_expires_at`, which the spine moves forward with
   * every message from them. Nothing here guesses a number from the lead's
   * phone or a window from the clock.
   */
  private async prepareWhatsApp(
    tx: TenantTx,
    organisationId: string,
    lead: LeadToAnswer,
    template: { id: string; body: string },
    decision: ReplyDecision,
  ): Promise<Claim> {
    const unsendable = (reason: string) =>
      this.recordUnsendable(tx, organisationId, lead.id, "whatsapp", decision, {
        reason,
        templateId: template.id,
      });

    const thread = lead.originConversationId
      ? await tx.conversation.findFirst({
          where: { id: lead.originConversationId, organisationId },
          select: {
            channel: true,
            channelConnectionId: true,
            replyWindowExpiresAt: true,
            identity: { select: { kind: true, value: true, status: true } },
          },
        })
      : null;
    if (!thread || thread.channel !== "whatsapp" || thread.identity.kind !== "wa_id") {
      // Unreachable for a lead the WhatsApp door made; said out loud so a
      // hand-logged "whatsapp_enquiry" can never send to a guessed number.
      return await unsendable("this enquiry has no WhatsApp conversation to reply on");
    }

    /**
     * 🚨 THE 24-HOUR WINDOW, CHECKED BEFORE THE SEND, BECAUSE META DOES NOT
     * REFUSE THE SEND — it accepts it and reports the failure later, on the
     * webhook (131047). An instant reply to a fresh enquiry is always inside
     * the window; this guard is for the re-run, the retry and the deferred
     * row that a later sweep picks up a day late. A reply outside the window
     * would need a paid template, which is the engine's business (3.5) and
     * needs the person's consent — so Eva stays silent and says why.
     */
    const now = new Date();
    if (!thread.replyWindowExpiresAt || thread.replyWindowExpiresAt.getTime() <= now.getTime()) {
      return await unsendable(
        "the 24-hour window for replying on WhatsApp has closed, so nothing was sent",
      );
    }

    /**
     * ⚠️ THE NUMBER THE PERSON WROTE TO, NOT "A" NUMBER. The window is a fact
     * about the pair, and a reply from a different number of ours would be a
     * business-initiated message to them. Asked for by the thread's own
     * connection id; nothing else is substituted.
     */
    const number = await this.numbers.resolveSendingNumber(tx, organisationId, "lead_follow_up", {
      connectionId: thread.channelConnectionId,
    });
    if (!number) {
      return await unsendable(
        "the WhatsApp number this enquiry came to is not connected for Lead Follow-up, so nothing was sent",
      );
    }

    const composed = composeWhatsAppReply(template.body);
    if (!composed.composed) return await unsendable(composed.reason);

    const row = await this.writeClaim(
      tx,
      organisationId,
      lead.id,
      "whatsapp",
      decision,
      template.id,
    );
    return {
      kind: "send",
      decisionId: row.id,
      delivery: {
        channel: "whatsapp",
        toWaId: thread.identity.value,
        bodyText: composed.bodyText,
        number,
        /**
         * The enquiry's own message id, so the reply quotes it in their chat.
         * Null when the evidence carries none — the reply still goes, plain.
         */
        replyToProviderMessageId: lead.evidence?.externalId ?? null,
      },
    };
  }

  /** The `pending` row that claims the lead. */
  private async writeClaim(
    tx: TenantTx,
    organisationId: string,
    leadId: string,
    channel: ReplyChannel,
    decision: ReplyDecision,
    templateId: string,
  ): Promise<{ id: string }> {
    return await tx.leadReplyDecision.create({
      data: {
        organisationId,
        leadId,
        channel,
        verdict: decision.verdict,
        reason: decision.reason,
        signal: decision.signal,
        status: "pending",
        templateId,
      },
      select: { id: true },
    });
  }

  /** A `reply` verdict that cannot actually be sent. Recorded, not thrown. */
  private async recordUnsendable(
    tx: TenantTx,
    organisationId: string,
    leadId: string,
    channel: ReplyChannel,
    decision: { verdict: string; reason: string; signal: string },
    unsendable: { reason: string; templateId?: string },
  ): Promise<Claim> {
    await tx.leadReplyDecision.create({
      data: {
        organisationId,
        leadId,
        channel,
        verdict: decision.verdict,
        reason: decision.reason,
        signal: decision.signal,
        status: "not_sent",
        failureReason: unsendable.reason,
        ...(unsendable.templateId ? { templateId: unsendable.templateId } : {}),
      },
    });
    return { kind: "done", outcome: { status: "not_sent", verdict: "reply" } };
  }

  private async settleSent(
    organisationId: string,
    decisionId: string,
    leadId: string,
    sent: Sent,
  ): Promise<void> {
    const now = new Date();
    await this.inTenant(organisationId, async (tx) => {
      await tx.leadReplyDecision.update({
        where: { id: decisionId },
        data: {
          status: "sent",
          toAddress: sent.to,
          // NULL off email, and the 0039 CHECK would refuse anything else.
          subject: sent.subject,
          body: sent.body,
          sentFrom: sent.from,
          sentAt: now,
        },
      });
      /**
       * ⚠️ SPEED-TO-LEAD IS MEASURED FROM WHEN THE ENQUIRY HAPPENED, and this
       * is the first thing that has ever set this column. `receivedAt` is their
       * clock (the schema says so); this is ours, and the gap between them is
       * the number the product exists to make small. Only set once — a later
       * manual reply must not overwrite the first response.
       */
      await tx.lead.updateMany({
        where: { id: leadId, firstRespondedAt: null },
        data: { firstRespondedAt: now },
      });

      /**
       * 🔑 THE SECOND WRITE FOR A REPLY (slice 3.3c). What Eva sent is a
       * message on the same thread as the enquiry, so the timeline shows both
       * halves. The decision row stays the product's own record of the send;
       * this is the platform's — and since 3.4a it carries Meta's id for the
       * message, which is what a delivery receipt names. An enquiry with no
       * thread — hand-logged, or one of the backfilled call-shaped leads —
       * keeps its decision and simply does not appear on a timeline it never
       * had.
       */
      const lead = await tx.lead.findFirst({
        where: { id: leadId },
        select: { originConversationId: true },
      });
      if (lead?.originConversationId) {
        await recordOutboundMessage(tx, {
          organisationId,
          conversationId: lead.originConversationId,
          senderKind: "assistant",
          subject: sent.subject,
          bodyText: sent.body,
          providerMessageId: sent.providerMessageId,
          sourceTable: "lead_reply_decisions",
          sourceId: decisionId,
          occurredAt: now,
        });
      } else {
        this.logger.info(
          { organisationId, leadId, decisionId },
          "reply sent on an enquiry with no thread; recorded on the decision, not on a timeline",
        );
      }
    });
  }

  private async settleFailure(
    organisationId: string,
    decisionId: string,
    leadId: string,
    channel: ReplyChannel,
    error: unknown,
  ): Promise<ReplyOutcome> {
    /**
     * ⚠️ THREE PROVIDER OUTCOMES, AND COLLAPSING THEM LOSES MAIL. This is the
     * lesson `outbound-mail.ts` records from slice 1.7: treating every provider
     * error as `failed` permanently binned reminders on a Microsoft 429 —
     * which only happens under load, i.e. exactly when a customer's book is
     * big. Nobody noticed until a debtor was never chased. The message port
     * (3.4a) has the same three, and they are read here the same way.
     */
    const { deferred, unusable, failureReason } = describeFailure(channel, error);

    await this.inTenant(organisationId, async (tx) => {
      await tx.leadReplyDecision.update({
        where: { id: decisionId },
        data: { status: deferred ? "deferred" : "failed", failureReason },
      });
    });

    /**
     * ⚠️ LOGGED AS A FAULT, BECAUSE NOTHING RETRIES IT YET. A `deferred` row
     * describes a reply that SHOULD go later, and slice 3.1c-3 builds no sweep
     * to send it. At this product's volumes a 429 is vanishingly rare, but
     * "rare" is not "handled" — the row is visible on the enquiry screen and
     * this log line is how we would find out it is happening at all. A retry
     * belongs with the review queue.
     */
    this.logger.warn(
      {
        organisationId,
        leadId,
        channel,
        deferred,
        unusable,
        // The port's own name and, for Meta, its code — never a body.
        err: error instanceof Error ? error.name : "unknown",
        ...(error instanceof MessageDeliveryError ? { code: error.code } : {}),
      },
      "an enquiry reply did not send",
    );
    return { status: deferred ? "deferred" : "failed" };
  }

  /**
   * ⚠️ SYSTEM CONTEXT — THE ORGANISATION IS DECLARED, THERE IS NO ACTING USER.
   * A stranger sent an email; nobody signed in, and naming a user here would
   * attribute Eva's unattended decision to whoever last touched the account.
   * The same shape `inbound-intake.service.ts` and the reconcile sweep use.
   *
   * `set_config(..., true)` is SET LOCAL: scoped to this transaction and never
   * inherited by the next borrower of a pooled connection — which is the whole
   * reason RLS can be trusted behind a pool.
   */
  private async inTenant<T>(organisationId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      return fn(rawTx as unknown as TenantTx);
    });
  }
}

/**
 * What the provider gets to look at, per channel — built from the raw row
 * the enquiry came from, which is the only honest source of a header or a
 * message type. A lead with no raw row (unreachable for either door) gets
 * the emptiest input its channel admits, which the rules hold rather than
 * answer.
 */
function decisionInputFor(channel: ReplyChannel, lead: LeadToAnswer): ReplyDecisionInput {
  switch (channel) {
    case "email": {
      const message = lead.inboundMessages[0];
      return {
        channel: "email",
        headers: (message?.headers as Record<string, string> | null) ?? {},
        fromAddress: lead.contactEmail ?? "",
        subject: message?.subject ?? null,
        body: lead.enquiry ?? "",
      };
    }
    case "whatsapp": {
      const delivery = lead.inboundChannelMessages[0];
      const payload = delivery?.payload;
      const message =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { message?: unknown }).message
          : undefined;
      const flags =
        message && typeof message === "object" && !Array.isArray(message)
          ? forwardingOf(message as Record<string, unknown>)
          : { forwarded: false, frequentlyForwarded: false };
      return {
        channel: "whatsapp",
        messageType: delivery?.messageType ?? "unsupported",
        forwarded: flags.forwarded,
        frequentlyForwarded: flags.frequentlyForwarded,
        text: delivery?.textBody ?? lead.enquiry ?? null,
      };
    }
  }
}

/** The sentence for the customer, and which of the three outcomes it was. */
function describeFailure(
  channel: ReplyChannel,
  error: unknown,
): { deferred: boolean; unusable: boolean; failureReason: string } {
  switch (channel) {
    case "email": {
      const deferred = error instanceof MailDeliveryDeferredError;
      const unusable = error instanceof MailboxUnusableError;
      return {
        deferred,
        unusable,
        failureReason: deferred
          ? "the mail provider was briefly unavailable, so the reply has not gone yet"
          : unusable
            ? "the mailbox needs reconnecting, so the reply has not gone"
            : "the reply could not be sent",
      };
    }
    case "whatsapp": {
      const deferred = error instanceof MessageDeliveryDeferredError;
      const unusable = error instanceof ChannelUnusableError;
      return {
        deferred,
        unusable,
        failureReason: deferred
          ? error.detail === "not_configured"
            ? "WhatsApp sending is not set up yet, so the reply has not gone"
            : "WhatsApp could not take the reply just now, so it has not gone yet"
          : unusable
            ? "the WhatsApp connection needs attention, so the reply has not gone"
            : "the reply could not be sent",
      };
    }
  }
}

export type ReplyOutcome =
  | { status: "sent" }
  | { status: "deferred" }
  | { status: "failed" }
  | { status: "not_sent"; verdict: string }
  | { status: "skipped"; reason: string };

/** The lead as `claim` reads it: with the raw rows the rules need. */
interface LeadToAnswer {
  id: string;
  source: string;
  contactEmail: string | null;
  enquiry: string | null;
  originConversationId: string | null;
  inboundMessages: { headers: unknown; subject: string | null }[];
  inboundChannelMessages: { messageType: string; textBody: string | null; payload: unknown }[];
  evidence: { externalId: string | null } | null;
}

/** Everything `send` needs, per channel, with the claim already written. */
type PreparedDelivery =
  | {
      channel: "email";
      to: string;
      subject: string;
      bodyText: string;
      account: SendingMailboxResolution["account"];
      actorUserId: string;
    }
  | {
      channel: "whatsapp";
      /** The person's WhatsApp id — the thread's reply handle. */
      toWaId: string;
      bodyText: string;
      number: SendingNumberResolution;
      replyToProviderMessageId: string | null;
    };

/** What went out, for the record. */
interface Sent {
  to: string;
  subject: string | null;
  body: string;
  from: string;
  providerMessageId: string | null;
}

type Claim =
  | { kind: "done"; outcome: ReplyOutcome }
  | { kind: "send"; decisionId: string; delivery: PreparedDelivery };
