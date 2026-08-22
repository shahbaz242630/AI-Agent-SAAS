import { parseFromHeader } from "../../../platform/leads/lead-from-email.js";

/**
 * Reading Google's forwarding confirmation email (Slice 3.1b, step 4).
 *
 * A Gmail customer cannot hand us their inbox — reading it is a RESTRICTED
 * scope and an audit every twelve months (ruling 25) — so they forward it
 * instead. Google guards that with a confirmation email sent TO THE FORWARDING
 * ADDRESS, which is ours. This file is how we read it, so the customer never
 * has to hunt for a code.
 *
 * ⚠️ THE PARSING HERE IS TAKEN FROM TWO REAL ARCHIVED MESSAGES, NOT FROM
 * MEMORY. Every fixture written from an author's own idea of a format agrees
 * with the parser written by the same author, which is how #104 shipped a lead
 * with no name and how #110 shipped a mailbox that could not send. The shapes
 * below come from public mailing-list archives of genuine Google mail:
 *
 *   Subject: (#99427480) Gmail Forwarding Confirmation - Receive Mail from a@b
 *   Subject: Gmail Forwarding Confirmation (#33821484) - Receive Mail from a@b
 *   Body:    a@b has requested to automatically forward mail to your email
 *            address c@d.
 *            Confirmation code: 33821484
 *            https://mail.google.com/mail/vf-<token>-…      (confirm)
 *            https://mail.google.com/mail/uf-<token>-…      (cancel)
 *
 * ⚠️ NOTE THE TWO SUBJECT ORDERINGS. The code is parenthesised in both and
 * placed differently, so nothing here anchors on its position.
 */

/** Who Google sends every one of these from, whoever asked for it. */
export const GOOGLE_FORWARDING_SENDER = "forwarding-noreply@google.com";

/**
 * ⚠️ TWO HOSTS, BOTH REAL. One archived message used `mail.google.com` and
 * another `mail-settings.google.com`. Allowing only the one we happened to see
 * first would mean half of all customers watching a screen that never moves.
 */
export const GOOGLE_CONFIRMATION_HOSTS = ["mail.google.com", "mail-settings.google.com"] as const;

/**
 * ⚠️ `vf-` CONFIRMS AND `uf-` CANCELS, AND THEY DIFFER BY ONE CHARACTER IN AN
 * OTHERWISE IDENTICAL URL — same host, same path, same token.
 *
 * This is the sharpest trap in the whole feature. "Find the Google link in the
 * body and follow it" is the obvious implementation and it is a coin flip that,
 * half the time, CANCELS the forwarding the customer just asked for — while
 * every status code says success and our screen says confirmed. The customer
 * would be told their enquiries are flowing while Google quietly discarded the
 * request, and nothing anywhere would disagree.
 *
 * So the prefix is matched explicitly, and the cancel link is never followed.
 */
const CONFIRM_PATH = /^\/mail\/vf-/;

/** `https://mail.google.com/mail/vf-…`, stopping at whatever ends a URL. */
const CONFIRM_URL = /https:\/\/mail(?:-settings)?\.google\.com\/mail\/vf-[^\s"'<>)\]]+/i;

/** `(#33821484)` — the code, in either subject ordering. */
const SUBJECT_CODE = /\(#(\d{4,})\)/;

/** `Confirmation code: 33821484` — the body's copy of the same number. */
const BODY_CODE = /Confirmation\s+code:\s*(\d{4,})/i;

/** `… - Receive Mail from someone@example.com` */
const SUBJECT_SOURCE = /Receive\s+Mail\s+from\s+([^\s<>,;]+@[^\s<>,;]+)/i;

/** `someone@example.com has requested to automatically forward mail …` */
const BODY_SOURCE = /([^\s<>,;]+@[^\s<>,;]+)\s+has\s+requested\s+to\s+automatically\s+forward/i;

/** Enough of a message for this file to have an opinion about it. */
export interface InboundMessageShape {
  /** The `From` header, verbatim. */
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
}

/** What Google's message asked for, as much of it as could be read. */
export interface ForwardingConfirmation {
  /** The mailbox asking to forward. Lowercased; the database insists. */
  sourceAddress: string;
  /** Google's numeric code — the fallback the screen shows if we cannot act. */
  code: string | null;
  /** The `vf-` link. Never the `uf-` one. */
  confirmUrl: string | null;
}

/**
 * Is this Google asking whether somebody may forward mail here?
 *
 * ⚠️ DELIBERATELY SEPARATE FROM READING THE DETAILS, AND THE SPLIT IS THE WHOLE
 * SAFETY ARGUMENT. Mail from `forwarding-noreply@google.com` is never somebody's
 * enquiry, whatever else we can or cannot parse out of it — so this question
 * answers "must not become a lead", and it answers it on the one fact that
 * cannot drift: who sent it.
 *
 * If Google reworded every sentence tomorrow, `readForwardingConfirmation`
 * below would return null and the customer's screen would stop advancing — but
 * a confirmation email would still never be filed as an enquiry from a
 * prospective customer called "Gmail Team". Getting that backwards is how a
 * front door starts putting robots in the book.
 *
 * ⚠️ A SPOOFED `From` IS NOT WORTH GUARDING HERE, AND THE REASON IS SPECIFIC.
 * Anyone can forge a header, but forging this one buys nothing: the only thing
 * we ever do with the contents is fetch a URL that `isConfirmationUrl` has
 * already restricted to Google's own hosts, and only inside a window the
 * customer opened. The cost of a forgery is one row on a screen saying somebody
 * asked; the cost of demanding a DKIM signature whose exact header shape we
 * have never seen is a real customer stuck forever.
 */
export function isForwardingConfirmation(message: InboundMessageShape): boolean {
  const { email } = parseFromHeader(message.from);
  return email === GOOGLE_FORWARDING_SENDER;
}

/**
 * Read the request out of Google's message.
 *
 * Returns null when the requesting mailbox cannot be identified from either the
 * subject or the body. That is a hard stop rather than a guess: the row exists
 * to let a customer answer "was this you?", and a request that cannot say who
 * asked is a question with no answer. The caller logs it loudly and still
 * refuses to make a lead — see `isForwardingConfirmation`.
 */
export function readForwardingConfirmation(
  message: InboundMessageShape,
): ForwardingConfirmation | null {
  if (!isForwardingConfirmation(message)) return null;

  const subject = message.subject ?? "";
  /**
   * ⚠️ TEXT FIRST FOR THE PROSE, HTML FIRST FOR THE URL, AND THAT IS NOT
   * INCONSISTENCY. Plain-text bodies are wrapped at about 78 characters by
   * every mail client there has ever been, and the confirmation URL is longer
   * than that — so the text copy of the link may well arrive split across two
   * lines with the tail silently lost. The HTML copy sits in an `href` and
   * cannot wrap. The sentences, by contrast, read cleanly out of the text and
   * would need tag-stripping out of the HTML.
   */
  const text = message.text ?? "";
  const html = message.html ?? "";

  const sourceAddress =
    firstAddress(subject.match(SUBJECT_SOURCE)) ??
    firstAddress(text.match(BODY_SOURCE)) ??
    firstAddress(stripTags(html).match(BODY_SOURCE));
  if (!sourceAddress) return null;

  const code = firstGroup(subject.match(SUBJECT_CODE)) ?? firstGroup(text.match(BODY_CODE));

  const confirmUrl = findConfirmUrl(html) ?? findConfirmUrl(text);

  return { sourceAddress, code, confirmUrl };
}

/**
 * Is this a URL we are willing to fetch?
 *
 * ⚠️ THIS IS AN SSRF GUARD, NOT A TIDINESS CHECK. The string it judges was
 * written by whoever sent the email, and the thing that happens next is our
 * server making a request to it from inside our own network. Anything that is
 * not plainly Google's own confirmation endpoint is refused: the scheme must be
 * https, the host must be one of the two we have actually seen, and the path
 * must begin `/mail/vf-`.
 *
 * ⚠️ THE HOST IS COMPARED WHOLE, NEVER WITH `endsWith`. `mail.google.com.evil`
 * ends with nothing useful, but `evil-mail.google.com` would pass a careless
 * suffix test and `mail.google.com@evil.test` fools anyone parsing by hand.
 * `URL` does the parsing and the comparison is an exact match against a list.
 */
export function isConfirmationUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (
    !GOOGLE_CONFIRMATION_HOSTS.includes(url.hostname as (typeof GOOGLE_CONFIRMATION_HOSTS)[number])
  )
    return false;
  return CONFIRM_PATH.test(url.pathname);
}

/** The `vf-` link in a body, if there is one we would actually follow. */
function findConfirmUrl(body: string): string | null {
  if (!body) return null;
  // `&amp;` is how an href survives HTML escaping; the archived links carry no
  // query string, but decoding costs nothing and a changed URL that gains one
  // would otherwise be mangled into something `new URL` still parses.
  const match = body.replace(/&amp;/gi, "&").match(CONFIRM_URL);
  if (!match) return null;
  // Trailing punctuation from prose — "click this link: https://…/vf-abc." —
  // is not part of the URL. Stripped only from the end, and only characters
  // that cannot begin a path segment.
  const trimmed = match[0].replace(/[.,;:]+$/, "");
  return isConfirmationUrl(trimmed) ? trimmed : null;
}

/** A captured address, lowercased and sanity-checked, or null. */
function firstAddress(match: RegExpMatchArray | null): string | null {
  const raw = firstGroup(match);
  if (!raw) return null;
  // Google writes a bare address here, but the same defensive read as the
  // sender side (#104): an angle-bracketed one must not become an address
  // with brackets in it, which no CHECK constraint would accept anyway.
  const { email } = parseFromHeader(raw);
  return email;
}

function firstGroup(match: RegExpMatchArray | null): string | null {
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

/** Tags out, so a sentence in the HTML half can be read as prose. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");
}
