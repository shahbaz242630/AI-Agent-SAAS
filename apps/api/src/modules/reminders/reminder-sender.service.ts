import { Inject, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "../mailboxes/mailboxes.service.js";
import type { SendingMailboxResolution } from "../mailboxes/mailboxes.service.js";
import {
  MailboxUnusableError,
  MailDeliveryDeferredError,
  REMINDER_MAIL_SENDER,
} from "../mailboxes/reminder-mail-sender.js";
import type { ReminderMailSender } from "../mailboxes/reminder-mail-sender.js";
import type { TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import { todayInTimezone } from "../invoices/invoice-status.js";
import { buildReminderMessage, type EmailReminderStepKey } from "./reminder-message.js";

const DEFAULT_TIMEZONE = "Europe/London";

/**
 * Why a due reminder did not go out. Reported per run and logged — never
 * swallowed, because a reminder that silently does not send is a revenue stall
 * nobody can see (the failure `mailboxes.service` calls the worst this product
 * could have).
 */
export type HeldReason =
  /** Every mailbox in the organisation is dead or gone (resolve returned null). */
  | "no_working_mailbox"
  /** The grant is revoked; only reconnecting fixes it. */
  | "reauth_required"
  /** The mailbox has no recorded owner, so no honest actor exists to refresh its token. */
  | "mailbox_owner_unknown"
  /** The invoice lost its contact (or its email) after the row was scheduled. */
  | "no_recipient"
  /** Rate-limited or a provider blip — retried on the next sweep, not lost. */
  | "provider_deferred";

export interface SendRemindersResult {
  sent: number;
  failed: number;
  /** Due, still owed, and deliberately left `ready` to be retried. */
  held: number;
  heldReasons: Partial<Record<HeldReason, number>>;
  /** Organisations whose whole batch threw — the sweep continues past them. */
  organisationsFailed: string[];
  /**
   * How many organisations the sweep walked, and how long it took.
   *
   * ⚠️ THIS IS THE SCALE TRIPWIRE, and it is why they are RETURNED rather than
   * only logged. The sweep is serial — one organisation, then one reminder, at
   * a time — which is correct and simple at our size and will not hold forever.
   * Because they are the task's return value, Trigger.dev's own run history
   * plots them with no metrics stack to build: the day `durationMs` starts
   * climbing towards the 300s `maxDuration`, we find out from a dashboard we
   * already have, rather than from a customer whose reminders stopped.
   */
  organisationsProcessed: number;
  durationMs: number;
}

interface Counts {
  sent: number;
  failed: number;
  held: number;
  heldReasons: Partial<Record<HeldReason, number>>;
}

function emptyCounts(): Counts {
  return { sent: 0, failed: 0, held: 0, heldReasons: {} };
}

function hold(counts: Counts, reason: HeldReason): void {
  counts.held += 1;
  counts.heldReasons[reason] = (counts.heldReasons[reason] ?? 0) + 1;
}

/** Whole days from the due date to the send day, in the ORG's timezone. */
function daysBetween(dueDate: Date, today: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((today.getTime() - dueDate.getTime()) / MS_PER_DAY);
}

/**
 * `ready` → `claimed`, and the answer to "is this send MINE to make?".
 *
 * The status is part of the WHERE, so two workers racing the same row produce
 * exactly one winner: the loser updates zero rows and walks away rather than
 * sending a second copy to the customer.
 *
 * ⚠️ EXPORTED AS A TX-LEVEL FUNCTION SO IT CAN BE PROVEN (the
 * `reminder-actions` precedent). As a private method its guard was untestable:
 * a mutation run deleted `status: "ready"` and every sender test stayed green,
 * because the sweep's read filters `sent` rows out long before the claim. The
 * only honest test calls this twice on one row and demands a single true.
 */
export async function claimReadyAction(tx: TenantTx, actionId: string): Promise<boolean> {
  const result = await tx.scheduledAction.updateMany({
    where: { id: actionId, status: "ready" },
    data: { status: "claimed" },
  });
  return result.count === 1;
}

/**
 * Sends the reminders that are due (Slice 1.7).
 *
 * Slice 1.5 built the queue and stopped at `ready`; this drives the rest of the
 * lifecycle. It is deliberately a separate service from `RemindersService`:
 * scheduling is pure database work inside one transaction, whereas sending
 * makes network calls that must NOT happen with a transaction open.
 *
 * ## Held is DERIVED, never stored
 *
 * When `resolveSendingMailbox` answers `null` — every mailbox dead — the row is
 * left `ready` rather than marked failed or skipped. That is the whole design:
 *
 * - A `failed`/`skipped` row is TERMINAL. The customer reconnects their mailbox
 *   and the reminder never goes out — the debt is quietly never chased.
 * - Left `ready`, the same row sends on the next sweep the moment a mailbox
 *   works again. It self-heals with no backfill and no migration.
 * - And "held" is a property of the ORGANISATION's mailbox health, not of the
 *   row. Stamping it on the row would be correct on the day it was written and
 *   silently wrong the moment a mailbox was reconnected — the trap
 *   `allocation.service` documents for allocation, and the same answer applies.
 *
 * ⚠️ So the visibility has to come from the RUN, not the row: every hold is
 * counted, logged and returned. A screen reads mailbox health to explain it.
 *
 * ## Claim before send, never after
 *
 * The claim (`ready` → `claimed`) commits BEFORE the Graph call, so two workers
 * cannot both send the same reminder. The cost is that a process killed between
 * claim and send strands the row in `claimed`. That is the right trade: a
 * duplicate chase is seen by the customer and damages the relationship, a
 * stranded row is invisible to them and recoverable by us.
 *
 * ⚠️ NOTHING RECOVERS A STRANDED `claimed` ROW YET. A stale-claim sweep is
 * still to build — see the slice handoff.
 */
@Injectable()
export class ReminderSenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailboxes: MailboxesService,
    @Inject(REMINDER_MAIL_SENDER) private readonly mail: ReminderMailSender,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * The sweep. Organisations come from the owner-owned SECURITY DEFINER
   * `list_active_organisations()` (migration 0010 — the only controlled
   * cross-tenant path), and each is processed in its own tenant context with
   * per-org failure isolation, exactly like the reconcile sweep.
   *
   * ⚠️ Batching per organisation is not tidiness: `resolveSendingMailbox`
   * THROWS if handed a customer from another tenant, precisely to stop org A's
   * debtor being chased from org B's address.
   */
  async sendDueReminders(): Promise<SendRemindersResult> {
    const rows = await this.prisma.db.$queryRaw<
      { list_active_organisations: string }[]
    >`SELECT * FROM list_active_organisations()`;

    const startedAt = Date.now();
    const total: SendRemindersResult = {
      sent: 0,
      failed: 0,
      held: 0,
      heldReasons: {},
      organisationsFailed: [],
      organisationsProcessed: 0,
      durationMs: 0,
    };

    for (const row of rows) {
      const organisationId = row.list_active_organisations;
      try {
        const counts = await this.sendForOrganisation(organisationId);
        total.sent += counts.sent;
        total.failed += counts.failed;
        total.held += counts.held;
        for (const [reason, count] of Object.entries(counts.heldReasons)) {
          const key = reason as HeldReason;
          total.heldReasons[key] = (total.heldReasons[key] ?? 0) + count;
        }
      } catch (error) {
        this.logger.error({ err: error, organisationId }, "reminder send failed for organisation");
        total.organisationsFailed.push(organisationId);
      }
      total.organisationsProcessed += 1;
    }

    if (total.held > 0) {
      // Deliberately at warn: a held reminder is money not being chased, and it
      // stays held until a human reconnects something.
      this.logger.warn(
        { held: total.held, reasons: total.heldReasons },
        "due reminders held — they will retry once a mailbox works",
      );
    }

    total.durationMs = Date.now() - startedAt;
    /**
     * ⚠️ EMITTED ON EVERY RUN, INCLUDING A COMPLETELY QUIET ONE.
     *
     * A sweep that logs only when something happens is indistinguishable from a
     * sweep that never ran — and "the timer silently stopped" is the failure
     * that would take longest to notice, because the symptom is nothing at all.
     * One line per run means its absence is the alert.
     */
    this.logger.info(
      {
        sent: total.sent,
        failed: total.failed,
        held: total.held,
        heldReasons: total.heldReasons,
        organisationsProcessed: total.organisationsProcessed,
        organisationsFailed: total.organisationsFailed.length,
        durationMs: total.durationMs,
      },
      "reminder send sweep complete",
    );
    return total;
  }

  private async sendForOrganisation(organisationId: string): Promise<Counts> {
    const counts = emptyCounts();

    // Phase 1 — read everything needed, resolve each mailbox, then CLOSE the
    // transaction. Nothing below this point may run with a transaction open:
    // `ensureAccessToken` opens its own (and must commit a rotated token
    // independently of whatever we do next), and the Graph call is network I/O.
    const jobs = await this.readDueWork(organisationId, counts);

    for (const job of jobs) {
      // Phase 2 — claim, and only send if WE won the row.
      const claimed = await this.claim(organisationId, job.actionId);
      if (!claimed) continue;

      // Phase 3 — the delivery, with NO transaction open. Token refresh lives
      // behind the port, on the provider's side of the line.
      try {
        await this.mail.deliver({
          organisationId,
          account: job.account,
          actorUserId: job.mailboxOwnerUserId,
          to: job.recipientEmail,
          subject: job.message.subject,
          bodyText: job.message.bodyText,
        });
      } catch (error) {
        if (error instanceof MailboxUnusableError) {
          // A revoked grant is not a failed reminder — nothing is wrong with
          // the invoice and nothing would be retried differently. Put the row
          // back so it goes out when the mailbox is reconnected.
          await this.release(organisationId, job.actionId);
          hold(counts, "reauth_required");
          this.logger.warn(
            { err: error, organisationId, scheduledActionId: job.actionId },
            "reminder held: mailbox needs reconnecting",
          );
          continue;
        }
        if (error instanceof MailDeliveryDeferredError) {
          // ⚠️ A RATE LIMIT IS NOT A FAILURE, and treating it as one loses mail
          // exactly when there is most of it. Back to `ready` for the next run.
          await this.release(organisationId, job.actionId);
          hold(counts, "provider_deferred");
          this.logger.warn(
            {
              organisationId,
              scheduledActionId: job.actionId,
              retryAfterSeconds: error.retryAfterSeconds,
            },
            "reminder deferred: provider busy",
          );
          continue;
        }
        await this.markFailed(organisationId, job);
        counts.failed += 1;
        this.logger.error(
          { err: error, organisationId, scheduledActionId: job.actionId },
          "reminder send failed",
        );
        continue;
      }

      await this.markSent(organisationId, job);
      counts.sent += 1;
    }

    return counts;
  }

  /**
   * One system transaction: read the due email rows, work out who each one is
   * for and which mailbox would send it, and build the message. Returns only
   * the rows that can actually be sent; everything else is counted as held
   * here and left `ready`.
   */
  private async readDueWork(organisationId: string, counts: Counts): Promise<SendJob[]> {
    return await this.prisma.db.$transaction(async (rawTx) => {
      // System context: no acting user, so only app.current_org is declared —
      // the reconcile sweep's precedent.
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      const tx = rawTx as unknown as TenantTx;

      const settings = await tx.organisationSettings.findUnique({ where: { organisationId } });
      const timezone = settings?.timezone ?? DEFAULT_TIMEZONE;
      const today = todayInTimezone(timezone);

      const organisation = await tx.organisation.findFirst({ where: { id: organisationId } });
      const organisationName = organisation?.name ?? "";

      const actions = await tx.scheduledAction.findMany({
        where: { status: "ready", actionType: "email", scheduledDate: { lte: today } },
        include: {
          reminderStep: true,
          invoice: { include: { contact: true, customer: true } },
        },
        orderBy: { scheduledDate: "asc" },
      });

      const jobs: SendJob[] = [];
      for (const action of actions) {
        const invoice = action.invoice;
        const contact = invoice.contact;
        const customer = invoice.customer;

        // The recipient can disappear between scheduling and sending — a
        // contact deleted, or its email cleared on the edit form.
        if (!contact?.email || !customer) {
          hold(counts, "no_recipient");
          continue;
        }

        const resolution = await this.mailboxes.resolveSendingMailbox(tx, organisationId, customer);
        if (resolution === null) {
          hold(counts, "no_working_mailbox");
          continue;
        }
        // No recorded owner means no honest actor for a token refresh. Fail
        // CLOSED and say why, rather than invent a user id to satisfy RLS.
        if (!resolution.account.connectedBy) {
          hold(counts, "mailbox_owner_unknown");
          continue;
        }

        jobs.push({
          actionId: action.id,
          invoiceId: invoice.id,
          account: resolution.account,
          mailboxOwnerUserId: resolution.account.connectedBy,
          mailboxSource: resolution.source,
          recipientEmail: contact.email,
          message: buildReminderMessage({
            stepKey: action.reminderStep.key as EmailReminderStepKey,
            invoiceReference: invoice.invoiceNumber,
            dueDate: invoice.dueDate,
            currency: invoice.currency,
            amountMinorUnits: invoice.amountMinorUnits,
            amountPaidMinorUnits: invoice.amountPaidMinorUnits,
            daysOverdue: daysBetween(invoice.dueDate, today),
            // The stored name as given, not a first name split out of it:
            // guessing which token is the given name is wrong often enough,
            // and across enough cultures, to be worse than the full name.
            contactName: contact.name,
            organisationName,
          }),
        });
      }
      return jobs;
    });
  }

  /** Commits the claim in its own transaction, BEFORE the send. */
  private async claim(organisationId: string, actionId: string): Promise<boolean> {
    return await this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      return await claimReadyAction(rawTx as unknown as TenantTx, actionId);
    });
  }

  /**
   * Puts a claimed row back to `ready` — the counterpart to a hold discovered
   * only after claiming. Without it a mailbox that needs reconnecting would
   * strand every one of its reminders in `claimed`, which is the terminal-state
   * failure this design exists to avoid, reached by a different road.
   */
  private async release(organisationId: string, actionId: string): Promise<void> {
    await this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      const tx = rawTx as unknown as TenantTx;
      await tx.scheduledAction.updateMany({
        where: { id: actionId, status: "claimed" },
        data: { status: "ready" },
      });
    });
  }

  /**
   * Audit metadata carries entity ids and counts only — never the amount, the
   * recipient's address or a line of the message body (BRD 14). "Which
   * reminder went out, when, and from which mailbox" is answerable; "what did
   * it say about how much money" is not, and must not be.
   */
  private async markSent(organisationId: string, job: SendJob): Promise<void> {
    await this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      const tx = rawTx as unknown as TenantTx;
      await tx.scheduledAction.update({ where: { id: job.actionId }, data: { status: "sent" } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: null,
        action: "reminder_action.sent",
        entityType: "invoice",
        entityId: job.invoiceId,
        metadata: {
          scheduledActionId: job.actionId,
          emailAccountId: job.account.id,
          // `substituted` means the mailbox the customer FILED this client
          // under is dead and another stood in. Recording it here is how that
          // stays answerable after the fact.
          mailboxSource: job.mailboxSource,
        },
      });
    });
  }

  private async markFailed(organisationId: string, job: SendJob): Promise<void> {
    await this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      const tx = rawTx as unknown as TenantTx;
      await tx.scheduledAction.update({ where: { id: job.actionId }, data: { status: "failed" } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: null,
        action: "reminder_action.failed",
        entityType: "invoice",
        entityId: job.invoiceId,
        metadata: { scheduledActionId: job.actionId, emailAccountId: job.account.id },
      });
    });
  }
}

interface SendJob {
  actionId: string;
  invoiceId: string;
  /** Derived from the resolver rather than restated — `ensureAccessToken` wants
   *  the whole account row, and a hand-written shape would drift from it. */
  account: SendingMailboxResolution["account"];
  mailboxOwnerUserId: string;
  mailboxSource: SendingMailboxResolution["source"];
  recipientEmail: string;
  message: { subject: string; bodyText: string };
}
