/**
 * Building the message Gmail actually wants (Slice 3.1b, step 3).
 *
 * ⚠️ MICROSOFT TAKES JSON; GOOGLE TAKES AN ENTIRE RFC 5322 MESSAGE. Graph is
 * handed `{subject, body, toRecipients}` and composes the mail itself. Gmail's
 * `users.messages.send` takes one field — `raw` — holding a base64url-encoded
 * email, headers and all. So this file is the part of Gmail support that has no
 * counterpart on the Microsoft side at all, and it is where the mistakes live.
 *
 * Kept separate from the provider so it can be tested without a network, a
 * token, or a stubbed `fetch` — every case below is a string in and a string
 * out.
 */

/**
 * A header value with a newline in it is a header INJECTION.
 *
 * ⚠️ THIS IS THE ONE GENUINELY DANGEROUS THING IN THIS FILE. Headers are
 * separated by CRLF, so a `to` or `subject` containing a line break can append
 * headers of its own — `Bcc:` being the obvious one, silently copying a
 * customer's mail to a stranger. Microsoft's JSON body made this impossible;
 * composing the message ourselves makes it possible, so it has to be refused
 * here.
 *
 * Stripped rather than rejected: the caller is our own reminder text and lead
 * subjects, so a line break is far more likely to be a stray newline in a
 * customer's invoice reference than an attack — and failing to send a chaser
 * over one is worse than sending it with the break removed. What must never
 * happen is that it reaches the message intact.
 */
export function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Does this need MIME encoding, or is plain ASCII enough? */
function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * A header value safe for any character, per RFC 2047 encoded-word.
 *
 * ⚠️ A BARE `£` OR `—` IN A SUBJECT LINE ARRIVES AS MOJIBAKE. Headers are
 * ASCII by specification; anything else has to be encoded. This project has
 * already been bitten by pound signs surviving in code and dying in transit,
 * and an invoice chaser whose subject reads "Invoice for Â£450" is a customer
 * emailing their own customer something broken.
 */
export function encodeHeaderValue(value: string): string {
  const safe = sanitiseHeaderValue(value);
  if (isAscii(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

export interface Rfc822Message {
  /**
   * Omitted when unknown: Gmail fills in the authenticated user's address, and
   * it refuses to send as anybody else anyway. A guessed `From` would be worse
   * than none — it is the header a recipient reads to decide whether the mail
   * is genuine.
   */
  from?: string;
  to: string;
  subject: string;
  bodyText: string;
}

/**
 * One plain-text message, ready to be base64url'd into Gmail's `raw` field.
 *
 * ⚠️ THE BODY IS BASE64, NOT RAW UTF-8, AND THAT IS NOT BELT AND BRACES.
 * Declaring `charset=UTF-8` while putting 8-bit bytes on the wire relies on
 * every hop honouring 8BITMIME; the ones that do not mangle exactly the
 * characters a UK business uses most — the pound sign, the em dash, curly
 * quotes. Base64 with `Content-Transfer-Encoding: base64` is 7-bit clean and
 * cannot be mangled by anything.
 *
 * Lines are wrapped at 76 characters because RFC 2045 requires it, and some
 * receivers reject or truncate longer ones.
 */
export function buildRfc822(message: Rfc822Message): string {
  const headers = [
    ...(message.from ? [`From: ${sanitiseHeaderValue(message.from)}`] : []),
    `To: ${sanitiseHeaderValue(message.to)}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(message.bodyText, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/**
 * Gmail's `raw` field: base64URL, not base64.
 *
 * ⚠️ THE DIFFERENCE IS THREE CHARACTERS AND IT IS NOT OPTIONAL. `+` and `/`
 * become `-` and `_`, and the `=` padding goes. Standard base64 is rejected
 * with a 400 that says nothing useful about why.
 */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}
