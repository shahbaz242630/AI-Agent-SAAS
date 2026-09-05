/**
 * "Does this enquiry deserve an automatic reply?" — the seam (slice 3.1c-2).
 *
 * ⚠️ THIS IS A DIFFERENT QUESTION FROM `spam-verdict.ts`, AND THE TWO MUST NOT
 * MERGE. That one asks "is this worth showing a human at all?" and answers it
 * with Amazon's judgement; it runs at intake, in the mailbox CAPABILITY, and a
 * message it refuses never becomes a lead. This one runs afterwards, in the
 * PRODUCT, over a lead that already exists, and asks the narrower question:
 * **should Eva write back to it, unread, in the customer's name?**
 *
 * A message can pass every spam check and still be the wrong thing to answer —
 * a delivery receipt, a newsletter, an out-of-office, a bounce. Those are not
 * spam. They are simply not somebody asking for work.
 *
 * ⚠️ NO AI, AND THE SEAM IS THE WHOLE POINT (founder ruling 54, 2026-09-01):
 * *"option 1 but offcourse AI later stage .. we will launch AI as our update"*.
 * The rules are behind this interface exactly like `ExtractionProvider`, so the
 * AI update is a new class and one line in the module — not a rewrite of the
 * reply path.
 *
 * ⚠️ ONE PORT, ONE INPUT SHAPE PER CHANNEL, AND NO LOWEST COMMON DENOMINATOR
 * (slice 3.4a). This file said, while email was the only channel: *"if the
 * product ever grows a second channel, the honest move is a second provider
 * behind this same port with its own signals, NOT a lowest-common-denominator
 * input that describes none of them well."* WhatsApp is that channel. Its
 * signals are nothing like email's — there are no headers, no bounces, no
 * mailing lists; there are message types, and Meta's own forwarded flags —
 * so `ReplyDecisionInput` is a union on `channel`, each arm carrying exactly
 * what its medium can say. The email arm is byte for byte what it was.
 * A provider that cannot tell one from the other has a type error, not a
 * silent default.
 */

/** DI token for the active reply-decision provider. */
export const REPLY_DECISION_PROVIDER = Symbol("REPLY_DECISION_PROVIDER");

/**
 * What Eva should do about one enquiry.
 *
 * ⚠️ THREE OUTCOMES, NOT TWO, AND THE MIDDLE ONE IS FOUNDER RULING 32:
 * *"err toward silence; the uncertain middle waits for a human"*. A boolean
 * would force every uncertain message into one of the two confident answers,
 * and both are wrong: replying risks answering a machine in the customer's
 * name, and silently not replying loses a real enquiry with nobody ever
 * finding out.
 */
export type ReplyVerdict =
  /** A person asking about work. Eva answers it. */
  | "reply"
  /**
   * Might be genuine, might not. Eva says nothing and it waits in the book for
   * somebody to look — the review queue, slice 3.1c-4.
   */
  | "hold"
  /**
   * Answering this would be wrong, and in the loop cases actively harmful.
   * Eva never replies and never asks anyone to.
   */
  | "never";

export interface ReplyDecision {
  verdict: ReplyVerdict;
  /**
   * Why, in words, for the human reading the enquiry screen.
   *
   * ⚠️ WRITTEN FOR A CUSTOMER, NOT A LOG. "this looks like an automatic
   * out-of-office reply, so Eva did not answer it" is something a plumber can
   * act on; `AUTO_SUBMITTED_HEADER` is not. The same rule `refusalReason`
   * follows in the capability.
   */
  reason: string;
  /**
   * The signal that decided it — a stable key for logs, metrics and tests.
   * Never shown to a customer.
   */
  signal: string;
}

/**
 * Everything the email rules may look at.
 *
 * ⚠️ THE BODY IS HERE AND THE RULES DO NOT USE IT, DELIBERATELY. Today's
 * answer comes entirely from headers and the sender, which are cheap, precise
 * and impossible to argue with. The body is passed because the AI provider this
 * seam exists for will need it, and adding it later would change the interface
 * for every implementation. It is the one piece of speculative generality here
 * and it is one field.
 */
export interface EmailReplyDecisionInput {
  channel: "email";
  /** Lower-cased header names, as the intake path stores them. */
  headers: Record<string, string>;
  /** The address Eva would write back to. */
  fromAddress: string;
  subject: string | null;
  body: string;
}

/**
 * Everything the WhatsApp rules may look at (slice 3.4a).
 *
 * There is no header a machine sets about itself on WhatsApp, and Meta has
 * already refused the spam it can see before a message reaches a business
 * number. What the medium does say is WHAT KIND of message this is and
 * whether it was passed along — and those are the only two signals a rule
 * here reads. The words are passed for the same reason email's body is.
 */
export interface WhatsAppReplyDecisionInput {
  channel: "whatsapp";
  /**
   * Meta's `type`: text | image | audio | video | document | sticker |
   * location | contacts | interactive | button | order | reaction | system |
   * unsupported | request_welcome | … Stored verbatim at intake; unknown values
   * arrive here as they are.
   */
  messageType: string;
  /** Meta's `context.forwarded` — the person passed somebody else's message on. */
  forwarded: boolean;
  /** Meta's `context.frequently_forwarded` — passed on many times: a chain message. */
  frequentlyForwarded: boolean;
  /** The words, if any. Null for a bare photo, a sticker or a location. */
  text: string | null;
}

export type ReplyDecisionInput = EmailReplyDecisionInput | WhatsAppReplyDecisionInput;

export interface ReplyDecisionProvider {
  decide(input: ReplyDecisionInput): ReplyDecision;
}
