/**
 * Turning whatever we know about a person or a company into something short
 * enough for a 28px disc (2026-08-09 design handoff).
 *
 * ⚠️ WE OFTEN DO NOT KNOW SOMEBODY'S NAME. Supabase gives us an email and a
 * user id; nothing in sign-up asks for a name. So every function here has to
 * produce something sensible from an email address alone, and none of them may
 * return an empty string — an initials disc with nothing in it reads as a
 * rendering fault, and "Morning, ." reads as a bug in the greeting.
 *
 * Pure and separate from the components so the awkward inputs can be tested:
 * one-word companies, hyphenated names, emails with dots and numbers, and the
 * empty string.
 */

/** The last-resort character, used only when there is genuinely nothing. */
const FALLBACK = "?";

/**
 * Up to two initials for an avatar disc.
 *
 * ⚠️ AN EMAIL IS NOT A NAME, so anything with an `@` is cut at it first —
 * otherwise "sam@northgate.co.uk" initials as "SN", taking the S from the
 * person and the N from their email provider.
 */
export function initialsFrom(value: string): string {
  const source = localPart(value);
  const words = source.split(/[\s._\-+]+/u).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0) return FALLBACK;
  if (words.length === 1) {
    // One word: two letters of it, because a single letter in a 28px disc
    // looks like a placeholder rather than a name.
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Something to call a person when nothing has asked them for their name.
 *
 * "sam.okafor@northgate.co.uk" becomes "Sam Okafor" — a guess, but a
 * recognisable one, and better than showing somebody their own login.
 */
export function displayNameFrom(value: string): string {
  const source = localPart(value);
  const words = source
    .split(/[\s._\-+]+/u)
    // Digits are almost always noise from an address ("sam.okafor2"), and a
    // name is never improved by them.
    .map((word) => word.replace(/\d+$/u, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return value.trim() || FALLBACK;
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

/**
 * The one word a greeting uses.
 *
 * ⚠️ NEVER RETURNS EMPTY. "Morning, ." is worse than no greeting at all, and
 * this is rendered on the first screen of the product.
 */
export function firstNameFrom(value: string): string {
  const first = displayNameFrom(value).split(" ")[0];
  return first && first.length > 0 ? first : FALLBACK;
}

/**
 * A role key as a person would say it: `read_only` → "Read only".
 *
 * ⚠️ DERIVED, NEVER A LOOKUP TABLE. A hardcoded map of the six roles would go
 * stale the day the API grows a seventh, and it would go stale SILENTLY — the
 * sidebar would show a blank or a raw `credit_controller` under the org name.
 * Reshaping whatever key arrives cannot drift, and the worst case is a label
 * that reads slightly stiffly rather than one that is wrong.
 */
export function roleLabel(roleKey: string): string {
  const words = roleKey.trim().replace(/[_-]+/gu, " ");
  if (words.length === 0) return "Member";
  return words[0]!.toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Everything before the `@`, or the whole string when there is not one.
 *
 * ⚠️ AN ADDRESS STARTING WITH `@` HAS NO LOCAL PART, and the first version of
 * this only cut when the `@` was at index 1 or later — so "@northgate.co.uk"
 * fell through as its whole self and initialled as "@C". Caught by the test for
 * exactly that input.
 */
function localPart(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  return at >= 0 ? trimmed.slice(0, at) : trimmed;
}
