/**
 * The seam ANY product sends a channel message through, from the
 * organisation's own connected number (slice 3.4a).
 *
 * ⚠️ THE SAME SHAPE AS `outbound-mail.ts`, INCLUDING THE THREE OUTCOMES, AND
 * THAT IS THE WHOLE DESIGN. A product hands over a resolved connection and
 * some words; what comes back is sent (with the provider's id), deferred
 * (nothing wrong with the message — try later) or unusable (a human has to
 * do something before anything on this connection can send). The mail port
 * learned the third outcome by losing mail: every provider error was
 * `failed`, which is terminal, so a rate limit under load permanently binned
 * a reminder. `docs/Slice 3.2/HANDOFF-3.2.md` §0.6 says in as many words
 * that the WhatsApp sender copies the shape and keeps all three.
 *
 * ⚠️ IT LIVES IN THE MESSAGING CAPABILITY, NOT IN THE PRODUCT, for the reason
 * the mail one lives in the mailbox: sending is machinery. Lead Follow-up is
 * the first caller; the engine (3.5) and the receptionist will be the next,
 * and none of them may learn what Meta calls its errors.
 *
 * ⚠️ WHAT IS *NOT* HERE. No subject — the medium has none. No template
 * name or category — every message through this port today is a free-form
 * reply inside the 24-hour window, which is a "service" message by Meta's
 * definition; the template port arrives with the nudges (3.5), where a
 * category first has a second value. No "to" address book — the recipient is
 * a WhatsApp id the person proved they hold by writing from it.
 */
export const OUTBOUND_MESSAGE = Symbol("OUTBOUND_MESSAGE");

export interface OutboundMessageDelivery {
  organisationId: string;
  /** The connection `resolveSendingNumber` chose: the number of OURS it leaves from. */
  connection: {
    id: string;
    /** Meta's phone number id — the thing the send is addressed to. */
    phoneNumberId: string;
  };
  /** The person's WhatsApp id: E.164 digits without the plus. */
  to: string;
  bodyText: string;
  /**
   * The id of the message being answered, so the reply quotes it in the
   * person's chat (Meta's "contextual reply"). Null sends a plain message.
   */
  replyToProviderMessageId: string | null;
}

export interface OutboundMessageReceipt {
  /** Meta's id for what was sent — the `wamid` its receipts will name. */
  providerMessageId: string;
}

/**
 * The connection cannot be used until a human does something: the token is
 * missing, expired or refused. A distinct type from a delivery failure on
 * purpose — nothing is wrong with the message, so the caller records it as
 * not gone rather than failed.
 */
export class ChannelUnusableError extends Error {
  constructor(
    readonly detail: string,
    cause?: unknown,
  ) {
    super(`channel needs attention: ${detail}`);
    this.name = "ChannelUnusableError";
    this.cause = cause;
  }
}

/**
 * Why a delivery was deferred, so the product can say something true about
 * it: `not_configured` is our missing piece (no token on this server),
 * `unreachable` means the provider was never reached, `provider_busy` means
 * it answered and said not now.
 */
export type DeferredDetail = "not_configured" | "unreachable" | "provider_busy";

/**
 * The provider could not take this message NOW, but nothing is wrong with it.
 * `Retry-After` is surfaced rather than obeyed, as the mail port does: the
 * caller defers the row; it does not sleep on a rate limit.
 */
export class MessageDeliveryDeferredError extends Error {
  constructor(
    readonly detail: DeferredDetail,
    readonly retryAfterSeconds: number | null,
    cause?: unknown,
  ) {
    super(`delivery deferred — ${detail.replace("_", " ")}`);
    this.name = "MessageDeliveryDeferredError";
    this.cause = cause;
  }
}

/**
 * The provider refused this message and will refuse it identically next time.
 * Carries Meta's code and title — never its body, which can quote request
 * material back — so the log says which rule was broken.
 */
export class MessageDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly title: string | null,
  ) {
    super(
      `the provider refused the message (HTTP ${status}${code === null ? "" : `, code ${code}`}${title ? `: ${title}` : ""})`,
    );
    this.name = "MessageDeliveryError";
  }
}

export interface OutboundMessage {
  deliver(delivery: OutboundMessageDelivery): Promise<OutboundMessageReceipt>;
}
