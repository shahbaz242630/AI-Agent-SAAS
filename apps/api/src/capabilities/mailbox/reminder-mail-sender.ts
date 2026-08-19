import { Inject, Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "./mailboxes.service.js";
import type { SendingMailboxResolution } from "./mailboxes.service.js";
import { MICROSOFT_GRAPH_PROVIDER } from "./microsoft-graph/microsoft-graph-provider.js";
import type { MicrosoftGraphProvider } from "./microsoft-graph/microsoft-graph-provider.js";
import {
  GraphRequestError,
  ReauthRequiredError,
} from "./microsoft-graph/microsoft-graph-provider.js";

/**
 * The seam the reminders module sends through (Slice 1.7).
 *
 * ⚠️ THIS EXISTS BECAUSE OF A TEST, AND THE TEST WAS RIGHT. Slice 1.5 left a
 * structural guard (`reminders.spec.ts`, plan §8 risk 7) asserting that no file
 * in the reminders module references a provider path, with the note that
 * *"sending arrives with 1.7 behind an integrations adapter — never scattered
 * direct provider calls"*. The first cut of the sender called
 * `graph.sendMail` directly and tripped it.
 *
 * So the reminders module knows only this port: give it a resolved mailbox and
 * some words, and it delivers them. Which provider, how a token is refreshed,
 * and what Microsoft calls its errors all stay on this side of the line — the
 * day a second provider arrives, the chase logic does not learn about it.
 */
export const REMINDER_MAIL_SENDER = Symbol("REMINDER_MAIL_SENDER");

export interface ReminderMailDelivery {
  organisationId: string;
  /** The mailbox `resolveSendingMailbox` chose. */
  account: SendingMailboxResolution["account"];
  /** Whose grant this is — the mailbox's `connected_by`. */
  actorUserId: string;
  to: string;
  subject: string;
  bodyText: string;
}

/**
 * The mailbox cannot be used until a human reconnects it. A distinct type from
 * a delivery failure on purpose: nothing is wrong with the reminder, so the
 * caller holds it rather than marking it failed.
 */
export class MailboxUnusableError extends Error {
  constructor(cause?: unknown) {
    super("mailbox needs reconnecting");
    this.name = "MailboxUnusableError";
    this.cause = cause;
  }
}

/**
 * The provider could not take this message NOW, but nothing is wrong with it.
 *
 * ⚠️ THIS EXISTS BECAUSE THE FIRST VERSION LOST MAIL AT SCALE. Every provider
 * error was treated the same and marked the row `failed`, which is terminal —
 * so a Microsoft 429 (which only happens under load, i.e. exactly when a real
 * customer's book is big) would have permanently binned that reminder. Nobody
 * would have noticed until a debtor was never chased.
 *
 * `Retry-After` is surfaced rather than obeyed here: this sweep does not sleep
 * on a rate limit, it defers the row to the next run. Honest and simple, and
 * it keeps a slow provider from holding a transaction or a worker open.
 */
export class MailDeliveryDeferredError extends Error {
  constructor(
    readonly retryAfterSeconds: number | null,
    cause?: unknown,
  ) {
    super("delivery deferred — the provider is busy or briefly unavailable");
    this.name = "MailDeliveryDeferredError";
    this.cause = cause;
  }
}

/**
 * Transient by HTTP status: 429 is rate limiting, 5xx is Microsoft having a
 * moment. Everything else (a malformed address, a refused recipient) is ours
 * and will fail identically next time, so it is a real failure.
 */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface ReminderMailSender {
  deliver(delivery: ReminderMailDelivery): Promise<void>;
}

/** The Microsoft 365 implementation of the port. */
@Injectable()
export class GraphReminderMailSender implements ReminderMailSender {
  constructor(
    private readonly mailboxes: MailboxesService,
    @Inject(MICROSOFT_GRAPH_PROVIDER) private readonly graph: MicrosoftGraphProvider,
  ) {}

  async deliver(delivery: ReminderMailDelivery): Promise<void> {
    let accessToken: string;
    try {
      // Refresh-on-use, and deliberately OUTSIDE any caller transaction: the
      // rotated pair is committed on its own before the send, because
      // Microsoft has already moved on by the time it returns.
      accessToken = await this.mailboxes.ensureAccessToken(
        delivery.organisationId,
        delivery.actorUserId,
        delivery.account,
      );
    } catch (error) {
      if (error instanceof ReauthRequiredError) throw new MailboxUnusableError(error);
      throw error;
    }
    try {
      await this.graph.sendMail(accessToken, {
        to: delivery.to,
        subject: delivery.subject,
        bodyText: delivery.bodyText,
      });
    } catch (error) {
      // A rate limit or a Microsoft blip must NOT close the reminder off; only
      // a fault in the message itself is a real failure.
      if (error instanceof GraphRequestError && isTransient(error.status)) {
        throw new MailDeliveryDeferredError(error.retryAfterSeconds, error);
      }
      if (error instanceof ReauthRequiredError) throw new MailboxUnusableError(error);
      throw error;
    }
  }
}
