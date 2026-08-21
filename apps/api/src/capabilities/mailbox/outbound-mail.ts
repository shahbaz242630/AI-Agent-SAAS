import { Inject, Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "./mailboxes.service.js";
import type { SendingMailboxResolution } from "./mailboxes.service.js";
import {
  MailProviderRequestError,
  ReauthRequiredError,
} from "./microsoft-graph/microsoft-graph-provider.js";
import {
  MAIL_PROVIDERS,
  providerFor,
  UnknownMailProviderError,
  type MailProviderRegistry,
} from "./mail-provider.js";

/**
 * The seam ANY product sends mail through, from the organisation's own mailbox.
 *
 * ⚠️ IT WAS CALLED `reminder-mail-sender` UNTIL 2026-08-19, AND THE NAME WAS A
 * TRAP. This is shared machinery in the mailbox capability, but it was named
 * after its first and only consumer — invoice follow-up's reminders. Lead
 * follow-up needs exactly this seam: a resolved mailbox and some words, sent.
 * Under the old name whoever built it would reasonably have concluded it was
 * somebody else's and written a second one, which is how a capability quietly
 * becomes two. Renamed while the split was being made, before that could happen.
 *
 * ⚠️ THIS EXISTS BECAUSE OF A TEST, AND THE TEST WAS RIGHT. Slice 1.5 left a
 * structural guard (`reminders.spec.ts`, plan §8 risk 7) asserting that no file
 * in the reminders module references a provider path, with the note that
 * *"sending arrives with 1.7 behind an integrations adapter — never scattered
 * direct provider calls"*. The first cut of the sender called
 * `graph.sendMail` directly and tripped it.
 *
 * So a product knows only this port: give it a resolved mailbox and
 * some words, and it delivers them. Which provider, how a token is refreshed,
 * and what Microsoft calls its errors all stay on this side of the line — the
 * day a second provider arrives, the chase logic does not learn about it.
 */
export const OUTBOUND_MAIL = Symbol("OUTBOUND_MAIL");

export interface OutboundMailDelivery {
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

export interface OutboundMail {
  deliver(delivery: OutboundMailDelivery): Promise<void>;
}

/**
 * Delivers through whichever provider the MAILBOX was connected with.
 *
 * ⚠️ THE PROVIDER COMES FROM THE ROW, NEVER FROM CONFIGURATION. A mailbox
 * connected through Microsoft is sent through Microsoft for the rest of its
 * life, whatever else is registered afterwards. Choosing per-send from anything
 * else — a default, an env var, "the newest adapter" — would mean a customer's
 * chaser going out through an account that never granted us anything.
 *
 * ⚠️ RENAMED FROM `GraphOutboundMail` (3.1b step 2). The old name was the same
 * trap this file already documents about `reminder-mail-sender`: naming shared
 * machinery after its only implementation. Whoever added Gmail under that name
 * would reasonably have written a second sender, and the retry, rate-limit and
 * reauth handling below — all of which was learned the hard way — would have
 * had to be learned again.
 */
@Injectable()
export class RoutedOutboundMail implements OutboundMail {
  constructor(
    private readonly mailboxes: MailboxesService,
    @Inject(MAIL_PROVIDERS) private readonly providers: MailProviderRegistry,
  ) {}

  async deliver(delivery: OutboundMailDelivery): Promise<void> {
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
      await providerFor(this.providers, delivery.account.provider).sendMail(accessToken, {
        to: delivery.to,
        subject: delivery.subject,
        bodyText: delivery.bodyText,
      });
    } catch (error) {
      // A rate limit or a provider blip must NOT close the reminder off; only
      // a fault in the message itself is a real failure.
      if (error instanceof MailProviderRequestError && isTransient(error.status)) {
        throw new MailDeliveryDeferredError(error.retryAfterSeconds, error);
      }
      if (error instanceof ReauthRequiredError) throw new MailboxUnusableError(error);
      /**
       * ⚠️ HELD, NOT FAILED — AND NOT PRESENTED AS "RECONNECT THIS MAILBOX".
       * A provider with no adapter is OUR missing piece, not a dead grant, so
       * telling the customer to reconnect would repeat defect F3: advice that
       * can never work, followed forever. Deferring keeps the reminder alive
       * and lets a deploy that ships the adapter heal it.
       *
       * Unreachable while `MAIL_PROVIDER_KEYS` and the database CHECK agree,
       * which `mailbox-providers.spec.ts` enforces. This is what happens if
       * that guard is ever removed.
       */
      if (error instanceof UnknownMailProviderError) {
        throw new MailDeliveryDeferredError(null, error);
      }
      throw error;
    }
  }
}
