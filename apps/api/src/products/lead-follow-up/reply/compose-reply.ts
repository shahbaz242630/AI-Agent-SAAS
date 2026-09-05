/**
 * Turning a template and an enquiry into the message that goes out (3.1c-3).
 *
 * Pure: strings in, strings out. No database, no network, no clock — so every
 * case below is testable without a fixture, which is the same reason
 * `rfc822.ts` was split out of the Gmail provider.
 *
 * ⚠️ EVA WRITES NOTHING. The body is the customer's template, verbatim. She
 * chooses WHICH wording and WHETHER to send; she does not compose. That is a
 * deliberate line and it is worth knowing why it is drawn here: under PECR the
 * difference between "providing technical delivery" and "instigating" the
 * message turns on exactly this, and the ICO fined a company £105,000 in
 * January 2026 whose defence was that it only sent on a client's behalf. The
 * more Eva writes, the more of that liability we take on. Keeping her mute is
 * the cheap, conservative answer, and `default-templates.ts` already documents
 * the same intent from the other end.
 */

export interface EnquiryToAnswer {
  /** Where the reply goes — the enquirer's own address. */
  contactEmail: string;
  /** The subject of the message they sent, if it had one. */
  originalSubject: string | null;
}

export interface ComposedReply {
  to: string;
  subject: string;
  bodyText: string;
}

/**
 * ⚠️ THREADING IS THE SUBJECT LINE, AND THAT IS NOT A SHORTCUT.
 *
 * The correct RFC way is `In-Reply-To` and `References` carrying the original
 * `Message-ID`, which we do store. **We cannot send it.** Gmail is handed a
 * whole RFC 5322 message so it could; Microsoft Graph takes JSON and restricts
 * `internetMessageHeaders` to `x-` prefixed names, so it cannot — and Graph's
 * proper reply endpoint needs the original message ID *in the customer's
 * mailbox*, which we deliberately never read (ruling 25).
 *
 * So a `Re:` subject is the one mechanism that threads on BOTH providers, and
 * it is what every mail client actually groups on anyway. Migration 0035's
 * comment already assumed this — it is why `lead_reply_templates` has no
 * `subject` column: the subject is derived, never authored.
 */
const REPLY_PREFIX = "Re: ";

/**
 * A subject for a reply to something with no subject of its own.
 *
 * ⚠️ NOT "Re: (no subject)". A stranger reads this in their inbox, and it
 * should look like a person answering them, not like a form. Plain, and it
 * says what the message is.
 */
const NO_SUBJECT_FALLBACK = "Thanks for your enquiry";

/**
 * ⚠️ ONE `Re:`, NOT A STACK OF THEM. A forwarded enquiry often already carries
 * `Re:` or `Fwd:`, sometimes several, and prefixing blindly produces
 * `Re: Re: Fwd: Re: leaking tap` — which is what a broken mailing list looks
 * like, on the customer's first impression. Localised prefixes are deliberately
 * NOT stripped: `AW:`, `SV:`, `RE :` and the rest are a long tail, and guessing
 * wrong mangles a real subject. Only the exact English ones we would add
 * ourselves are collapsed.
 */
function alreadyAReply(subject: string): boolean {
  return /^re\s*:/i.test(subject.trim());
}

function stripLeadingForwards(subject: string): string {
  // `Fwd:`/`Fw:` stack the same way, and a forwarded enquiry is the ordinary
  // case for this product (a customer forwards it in, ruling 26's filter).
  let out = subject.trim();
  let previous: string;
  do {
    previous = out;
    out = out.replace(/^(fwd?|fw)\s*:\s*/i, "").trim();
  } while (out !== previous);
  return out;
}

/**
 * ⚠️ HEADER INJECTION IS REFUSED HERE AS WELL AS IN `rfc822.ts`, AND NOT ONLY
 * BECAUSE OF GMAIL. The subject is built from an ATTACKER-CONTROLLED string —
 * a stranger chooses what to put in the subject of the mail they send. Gmail's
 * composer strips newlines on its own, but Microsoft's JSON path never had to,
 * so the guard cannot live only in the Google adapter. Stripped rather than
 * refused, for `rfc822.ts`'s reason: a stray newline is far likelier than an
 * attack, and failing to answer an enquiry over one is the worse outcome.
 */
function singleLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * ⚠️ CAPPED, BECAUSE THE SUBJECT COMES FROM A STRANGER. RFC 5322 recommends
 * lines under 998 octets and mail clients truncate long subjects anyway; an
 * unbounded one lets somebody put a paragraph in a customer's sent folder.
 * 200 is comfortably past any real subject.
 */
const MAX_SUBJECT = 200;

export function replySubject(originalSubject: string | null): string {
  const cleaned = singleLine(originalSubject ?? "");
  if (cleaned === "") return NO_SUBJECT_FALLBACK;

  const withoutForwards = stripLeadingForwards(cleaned);
  if (withoutForwards === "") return NO_SUBJECT_FALLBACK;

  const subject = alreadyAReply(withoutForwards)
    ? withoutForwards
    : `${REPLY_PREFIX}${withoutForwards}`;

  return subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1).trimEnd()}…` : subject;
}

/**
 * The message Eva sends, or a refusal that says which piece is missing.
 *
 * ⚠️ IT RETURNS A REASON RATHER THAN THROWING. Every caller of this is deciding
 * what to write on a customer's screen next to an unanswered enquiry, and
 * "there is no address to reply to" is a sentence they can act on. An exception
 * would arrive as "something went wrong".
 */
export type ComposeResult =
  { composed: true; reply: ComposedReply } | { composed: false; reason: string };

export function composeReply(enquiry: EnquiryToAnswer, templateBody: string): ComposeResult {
  const to = enquiry.contactEmail.trim();
  if (to === "" || !to.includes("@")) {
    return { composed: false, reason: "there is no address to reply to" };
  }
  /**
   * ⚠️ A NEWLINE IN THE RECIPIENT IS THE DANGEROUS ONE. `rfc822.ts` calls this
   * out as "the one genuinely dangerous thing in this file" — a `to` carrying
   * CRLF can append a `Bcc:` and copy a customer's mail to a stranger. It is
   * refused outright here rather than stripped, because unlike a subject there
   * is no benign reason for it and a mangled address sends nowhere useful.
   */
  if (/[\r\n]/.test(to)) {
    return { composed: false, reason: "the reply address is not a usable email address" };
  }

  const bodyText = templateBody.trim();
  if (bodyText === "") {
    return { composed: false, reason: "the reply wording is empty" };
  }

  return {
    composed: true,
    reply: { to, subject: replySubject(enquiry.originalSubject), bodyText },
  };
}

/**
 * The WhatsApp reply (slice 3.4a): the customer's wording, verbatim, and
 * nothing else. No subject exists to derive; the recipient is the thread's
 * own handle and is not this function's to check; and the reply quotes the
 * person's message by id at the send, not by pasting it here.
 *
 * ⚠️ 4,096 IS META'S LIMIT ON A TEXT BODY and the template cap is 4,000, so
 * the wording always fits; the check is here so the day the cap moves, the
 * failure is a sentence on the enquiry screen rather than a Meta error code.
 */
export const MAX_WHATSAPP_BODY = 4096;

export type ComposeWhatsAppResult =
  { composed: true; bodyText: string } | { composed: false; reason: string };

export function composeWhatsAppReply(templateBody: string): ComposeWhatsAppResult {
  const bodyText = templateBody.trim();
  if (bodyText === "") {
    return { composed: false, reason: "the reply wording is empty" };
  }
  if (bodyText.length > MAX_WHATSAPP_BODY) {
    return { composed: false, reason: "the reply wording is too long for a WhatsApp message" };
  }
  return { composed: true, bodyText };
}
