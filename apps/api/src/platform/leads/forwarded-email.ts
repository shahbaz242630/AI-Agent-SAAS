/**
 * Reading a manually forwarded enquiry (slice 3.1c-0b).
 *
 * ⚠️ THIS IS NOT COSMETIC TIDYING — WITHOUT IT EVA ANSWERS THE WRONG PERSON.
 * When a customer presses Forward on an enquiry, two things happen at once:
 * the `From` header becomes THE CUSTOMER, and their own covering note lands at
 * the TOP of the body with the actual enquiry below a fold. Observed on a real
 * lead in production, 2026-09-01:
 *
 *     This is test email 2
 *     Kind Regards
 *
 *     Shahbaz Malik
 *
 *     Begin forwarded message:
 *
 *     From: Jane Smith <jane@example.com>
 *     ...
 *
 * So Eva files the lead against the person who forwarded it, quotes their
 * covering note as the enquiry, and — once 3.1c can reply — would send the
 * answer back to her own customer instead of to Jane. Every one of those is
 * silent; the lead looks perfectly normal in the book.
 *
 * ⚠️ AUTOMATIC FORWARDING IS FINE AND IS NOT THIS. A Gmail filter (ruling 26)
 * preserves the original `From` and adds no covering note, which is why the
 * product works today. This is only the manual case — somebody pressing
 * Forward — and that case is exactly the one a customer reaches for when they
 * want Eva to handle something that arrived before setup.
 *
 * ⚠️ IT REFUSES RATHER THAN GUESSES, AND THAT ORDERING IS THE WHOLE DESIGN.
 * `lead-from-email.ts` already carries the rule: "never mistake a display name
 * for an address — `contact_email` is what Eva will reply to, and replying to
 * the wrong string is worse than failing to parse." The same applies here, one
 * level up. Every function below returns `null` the moment it is unsure, and
 * `null` means "treat it as an ordinary message", which is today's behaviour
 * and is never dangerous. A half-parsed forward would be.
 */

/**
 * The line clients put above a forwarded block.
 *
 * Deliberately a small, closed list of the ones real clients actually emit —
 * Apple Mail and iOS, Gmail, and Outlook. A looser rule (anything containing
 * the word "forwarded") would match a customer WRITING about a forward, which
 * is a sentence, not a fold.
 */
const FORWARD_MARKERS: readonly RegExp[] = [
  // Apple Mail, iOS Mail.
  /^\s*begin forwarded message:\s*$/i,
  // Gmail. The dash count varies between clients and locales.
  /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  // Outlook desktop.
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
];

/** A `Name: value` header line inside a forwarded block. */
const HEADER_LINE = /^([A-Za-z-]+):\s*(.*)$/;

/** Header names a forwarded block may carry, lower-cased. `Sent` is Outlook's
 *  spelling of `Date`. */
const FORWARD_HEADERS = new Set(["from", "date", "sent", "to", "cc", "subject", "reply-to"]);

/** How many lines of header block to tolerate before giving up. A real one is
 *  four or five; anything longer means we are not looking at headers. */
const MAX_HEADER_LINES = 12;

export interface UnwrappedForward {
  /** The ORIGINAL sender's `From` value, verbatim — `Jane <jane@x.com>` or bare.
   *  Handed to the same address parser the un-forwarded path uses. */
  from: string;
  /** The enquiry as the original sender wrote it, with the covering note and
   *  the header block removed. Never empty. */
  body: string;
  /** The original `Subject`, when the block carried one. */
  subject: string | null;
}

/**
 * Some clients quote the forwarded part with `>`. Strip one level so the header
 * block is readable; more than one level means a forward of a reply of a
 * forward, which is past the point where guessing is safe.
 */
function unquote(line: string): string {
  return line.startsWith(">") ? line.slice(1).replace(/^ /, "") : line;
}

/** Index of the marker line, or -1. */
function findMarker(lines: readonly string[]): number {
  return lines.findIndex((line) => {
    const bare = unquote(line);
    return FORWARD_MARKERS.some((marker) => marker.test(bare));
  });
}

/**
 * Reads the `Name: value` header block that follows a marker.
 *
 * Returns null unless it finds a `From`, because `from` is the entire point —
 * a forwarded block we cannot attribute is one we must not act on.
 */
function readHeaders(
  lines: readonly string[],
  start: number,
): { headers: Map<string, string>; bodyStart: number } | null {
  const headers = new Map<string, string>();
  let i = start;
  // A blank line between the marker and the headers is normal.
  while (i < lines.length && unquote(lines[i]!).trim() === "") i += 1;

  const limit = Math.min(i + MAX_HEADER_LINES, lines.length);
  while (i < limit) {
    const line = unquote(lines[i]!);
    if (line.trim() === "") break;
    const match = line.match(HEADER_LINE);
    if (!match) {
      /**
       * ⚠️ A NON-HEADER LINE INSIDE THE BLOCK ENDS IT, RATHER THAN BEING
       * SKIPPED. Skipping would let a line of the customer's prose sit between
       * two headers and still produce a "successful" parse — which is how a
       * confident wrong answer gets built.
       */
      break;
    }
    const name = match[1]!.toLowerCase();
    if (!FORWARD_HEADERS.has(name)) break;
    // First value wins: a repeated header in a forwarded block is malformed,
    // and preferring the later one would let anything appended override it.
    if (!headers.has(name)) headers.set(name, match[2]!.trim());
    i += 1;
  }

  if (!headers.has("from")) return null;
  return { headers, bodyStart: i };
}

/**
 * The original enquiry inside a manually forwarded message, or `null` when this
 * is not one — or is one we cannot read with confidence.
 *
 * ⚠️ `null` IS A NORMAL, SAFE ANSWER AND MOST MESSAGES GET IT. It means "use
 * the message as it arrived", which is exactly what happened before this
 * function existed. Callers must not treat it as an error.
 */
export function unwrapForwardedEmail(text: string | null): UnwrappedForward | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);

  const marker = findMarker(lines);
  if (marker === -1) return null;

  const parsed = readHeaders(lines, marker + 1);
  if (!parsed) return null;

  const from = parsed.headers.get("from")!;
  /**
   * ⚠️ AN `@` IS THE MINIMUM, AND IT IS CHECKED HERE RATHER THAN LEFT TO THE
   * ADDRESS PARSER. A `From:` with no address at all (some clients write only
   * a display name) would otherwise reach `contact_email` as a name, and the
   * one thing this file must never do is hand Eva a reply-to that is not an
   * address.
   */
  if (!from.includes("@")) return null;

  const body = lines.slice(parsed.bodyStart).map(unquote).join("\n").trim();
  // A forward with headers and no message below them tells us nothing the
  // original did not; falling back keeps the covering note, which at least
  // exists.
  if (body === "") return null;

  const subject = parsed.headers.get("subject");
  return {
    from,
    body,
    subject: subject && subject !== "" ? subject : null,
  };
}
