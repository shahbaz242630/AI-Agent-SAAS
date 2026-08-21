/**
 * The do-not-contact screen's own words (2026-08-21).
 *
 * ⚠️ PURE, FOR THE SAME REASON `lead-book.ts` IS. The page is an async server
 * component that redirects and fetches, so no plain node test can render one.
 * Every rule worth getting right lives here instead, where a test can reach it.
 */

/** What a suppressed row says about how it reached the list. */
export function channelLabel(channel: string): string {
  if (channel === "email") return "Email address";
  if (channel === "call") return "Phone number";
  // A channel this build has not heard of — `whatsapp` lands here when Phase 3
  // adds it, and the raw key must never reach a customer.
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

/**
 * Why this person is on the list, in a sentence.
 *
 * ⚠️ `lead_requested` IS A DATABASE WORD AND MUST NOT BE PRINTED. It is what
 * `doNotContact` writes as the reason, and "lead_requested" on a screen is the
 * same defect as "modules" leaking onto the sidebar.
 */
export function suppressionReasonLine(reason: string | null): string {
  if (reason === "lead_requested") return "They asked not to be contacted again.";
  if (reason === null || reason.trim() === "") return "No reason was recorded.";
  return reason;
}

/** Who recorded it, when a name could not be resolved. */
export function recordedByLine(recordedBy: string | null): string {
  // ⚠️ NOT "UNKNOWN". The name is missing because that person is no longer a
  // member of this organisation — the users table is readable as "yourself plus
  // this tenant's members" — and "unknown" reads as data loss.
  return recordedBy ?? "someone who has since left";
}

/**
 * The count line above the list.
 *
 * ⚠️ IT COUNTS ADDRESSES AND NUMBERS, NOT PEOPLE, AND IT USED TO SAY "people".
 * Found by walking production on 2026-08-21: one do-not-contact on one enquiry
 * put an address AND a number on the list, and the screen announced "2 people
 * Eva will not contact" about a single person. We cannot know which values
 * belong to the same human — suppression is by value, deliberately — so the
 * honest count is of entries, and the wording has to match what is counted.
 */
export function doNotContactCountLine(total: number): string {
  if (total === 0) return "Nobody is on this list.";
  if (total === 1) return "One address or number Eva will not use.";
  return `${total} addresses and numbers Eva will not use.`;
}

/**
 * Whether a stated reason is enough to record a correction.
 *
 * ⚠️ TEN CHARACTERS, AND IT MATCHES THE API EXACTLY. The same minimum is in
 * `correctSuppressionRequestSchema`; this copy exists so somebody is refused
 * before a round trip, never so the screen can be more lenient. If these two
 * ever disagree, the API's answer is the one that counts.
 *
 * The bar is deliberately above "mistake": this sentence is what somebody reads
 * in a year when asking why a do-not-contact was undone, and one word answers
 * nothing.
 */
export const CORRECTION_REASON_MIN = 10;

export function correctionReasonRefusal(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === "") return "Say why this was recorded in error.";
  if (trimmed.length < CORRECTION_REASON_MIN) {
    return "Give a bit more detail — this is the record of why the entry was undone.";
  }
  return null;
}
