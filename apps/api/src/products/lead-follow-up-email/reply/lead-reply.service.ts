import { Inject, Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "../../../capabilities/mailbox/mailboxes.service.js";
import {
  MailboxUnusableError,
  MailDeliveryDeferredError,
  OUTBOUND_MAIL,
  type OutboundMail,
} from "../../../capabilities/mailbox/outbound-mail.js";
import type { TenantTx } from "../../../platform/permissions/permissions.js";
import { REPLY_DECISION_PROVIDER, type ReplyDecisionProvider } from "../decision/reply-decision.js";
import { composeReply } from "./compose-reply.js";

/**
 * Answering one enquiry (slice 3.1c-3) — the half of the product the catalogue
 * blurb has been promising since 3.1a.
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
 * ⚠️ RESEND RETRIES A WEBHOOK THAT DOES NOT ANSWER 200 — "immediately, then a
 * few more times over the next 36 hours". Intake is already idempotent on
 * `provider_message_id`; this is the second effect and needs its own guard, or
 * a retried delivery sends the same automatic reply twice in the customer's
 * name.
 */
@Injectable()
export class LeadReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailboxes: MailboxesService,
    @Inject(OUTBOUND_MAIL) private readonly outbound: OutboundMail,
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
    try {
      await this.outbound.deliver({
        organisationId,
        account: claim.account,
        actorUserId: claim.actorUserId,
        to: claim.reply.to,
        subject: claim.reply.subject,
        bodyText: claim.reply.bodyText,
      });
    } catch (error) {
      return await this.settleFailure(organisationId, claim.decisionId, leadId, error);
    }

    await this.settleSent(organisationId, claim.decisionId, leadId, {
      to: claim.reply.to,
      subject: claim.reply.subject,
      body: claim.reply.bodyText,
      from: claim.account.emailAddress,
      templateId: claim.templateId,
    });
    this.logger.info({ organisationId, leadId }, "replied to an enquiry");
    return { status: "sent" };
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
          /** The delivery it came from — where the headers the rules read live. */
          inboundMessages: { orderBy: { receivedAt: "desc" }, take: 1 },
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

      const message = lead.inboundMessages[0];
      const decision = this.decisions.decide({
        headers: (message?.headers as Record<string, string> | null) ?? {},
        fromAddress: lead.contactEmail ?? "",
        subject: message?.subject ?? null,
        body: lead.enquiry ?? "",
      });

      /** A refusal or a hold: record it and stop. Nothing went wrong. */
      if (decision.verdict !== "reply") {
        await tx.leadReplyDecision.create({
          data: {
            organisationId,
            leadId,
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
      const template = await tx.leadReplyTemplate.findFirst({
        where: { isAutomatic: true, deletedAt: null },
        select: { id: true, body: true },
      });
      if (!template) {
        return await this.recordUnsendable(tx, organisationId, leadId, decision, {
          reason: "no automatic reply is switched on, so nothing was sent",
        });
      }

      const composed = composeReply(
        { contactEmail: lead.contactEmail ?? "", originalSubject: message?.subject ?? null },
        template.body,
      );
      if (!composed.composed) {
        return await this.recordUnsendable(tx, organisationId, leadId, decision, {
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
        "lead_follow_up_email",
        { organisationId, emailAccountId: null },
      );
      if (!resolution) {
        return await this.recordUnsendable(tx, organisationId, leadId, decision, {
          reason: "no mailbox is connected for Lead Follow-up, so nothing was sent",
          templateId: template.id,
        });
      }

      const row = await tx.leadReplyDecision.create({
        data: {
          organisationId,
          leadId,
          verdict: decision.verdict,
          reason: decision.reason,
          signal: decision.signal,
          status: "pending",
          templateId: template.id,
        },
        select: { id: true },
      });

      return {
        kind: "send",
        decisionId: row.id,
        templateId: template.id,
        reply: composed.reply,
        account: resolution.account,
        /**
         * Whose grant this is. `connectedBy` is the person who authorised the
         * mailbox; a refresh happens under their consent, not a stranger's.
         */
        actorUserId: resolution.account.connectedBy ?? "",
      };
    });
  }

  /** A `reply` verdict that cannot actually be sent. Recorded, not thrown. */
  private async recordUnsendable(
    tx: TenantTx,
    organisationId: string,
    leadId: string,
    decision: { verdict: string; reason: string; signal: string },
    unsendable: { reason: string; templateId?: string },
  ): Promise<Claim> {
    await tx.leadReplyDecision.create({
      data: {
        organisationId,
        leadId,
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
    sent: { to: string; subject: string; body: string; from: string; templateId: string },
  ): Promise<void> {
    const now = new Date();
    await this.inTenant(organisationId, async (tx) => {
      await tx.leadReplyDecision.update({
        where: { id: decisionId },
        data: {
          status: "sent",
          toAddress: sent.to,
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
    });
  }

  private async settleFailure(
    organisationId: string,
    decisionId: string,
    leadId: string,
    error: unknown,
  ): Promise<ReplyOutcome> {
    /**
     * ⚠️ THREE PROVIDER OUTCOMES, AND COLLAPSING THEM LOSES MAIL. This is the
     * lesson `outbound-mail.ts` records from slice 1.7: treating every provider
     * error as `failed` permanently binned reminders on a Microsoft 429 —
     * which only happens under load, i.e. exactly when a customer's book is
     * big. Nobody noticed until a debtor was never chased.
     */
    const deferred = error instanceof MailDeliveryDeferredError;
    const unusable = error instanceof MailboxUnusableError;

    const failureReason = deferred
      ? "the mail provider was briefly unavailable, so the reply has not gone yet"
      : unusable
        ? "the mailbox needs reconnecting, so the reply has not gone"
        : "the reply could not be sent";

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
      { organisationId, leadId, deferred, unusable },
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

export type ReplyOutcome =
  | { status: "sent" }
  | { status: "deferred" }
  | { status: "failed" }
  | { status: "not_sent"; verdict: string }
  | { status: "skipped"; reason: string };

type Claim =
  | { kind: "done"; outcome: ReplyOutcome }
  | {
      kind: "send";
      decisionId: string;
      templateId: string;
      reply: { to: string; subject: string; bodyText: string };
      account: Awaited<ReturnType<MailboxesService["resolveSendingMailbox"]>> extends infer R
        ? R extends { account: infer A }
          ? A
          : never
        : never;
      actorUserId: string;
    };
