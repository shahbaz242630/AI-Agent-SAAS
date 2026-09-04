/**
 * A handle, normalised before it reaches the spine (slice 3.3b, blueprint
 * §3.3 step 1).
 *
 * ⚠️ THE DATABASE REFUSES ANYTHING THAT IS NOT NORMALISED, AND THESE ARE THE
 * SAME SHAPES. Migration 0041 puts a CHECK on `person_identities.value` per
 * kind — lowercased email, `+`-prefixed E.164, digits for a WhatsApp id — and
 * on `people.primary_email` / `primary_phone`. The regexes here are copied
 * from that migration, not paraphrased, so a value this file accepts is a
 * value the row will take. The backfill in the same migration normalised the
 * existing rows with the same rules, which is what lets a message arriving
 * today find the person the backfill made yesterday.
 *
 * ⚠️ A NATIONAL NUMBER IS REFUSED, NEVER GUESSED. `07700 900123` is a
 * different number in every country, and a guess stored as fact would have
 * Eva reply to a stranger. Only a number that names its country — `+44…` or
 * `0044…` — is a phone handle; anything else is not stored as one. The web
 * app's `normalisePhoneInput` makes the same call at the form.
 */

/** Exactly one `@`, no whitespace, a dot in the domain — the CHECK's shape. */
export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** E.164 with the plus: 7 to 15 digits, no leading zero. */
export const E164_SHAPE = /^\+[1-9][0-9]{6,14}$/;

/** WhatsApp's own id for a person: the E.164 digits without the plus. */
export const WA_ID_SHAPE = /^[0-9]{6,15}$/;

/** Trimmed and lowercased, or null when it is not an address at all. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return EMAIL_SHAPE.test(value) ? value : null;
}

/**
 * `+44 7700 900123`, `+44 (0)7700-900123` and `0044 7700 900123` all become
 * `+447700900123`. Anything without a country prefix becomes null.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9+]/g, "");
  if (E164_SHAPE.test(digits)) return digits;
  if (/^00[1-9][0-9]{6,14}$/.test(digits)) return `+${digits.slice(2)}`;
  return null;
}

/** The digits WhatsApp sent, or null when they are not a WhatsApp id. */
export function normaliseWaId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return WA_ID_SHAPE.test(value) ? value : null;
}

/**
 * A WhatsApp id IS the person's number in E.164 without its plus, so the
 * phone handle needs no country lookup — the id already names it. Null for
 * the rare id that is not a dialable number.
 */
export function phoneFromWaId(waId: string): string | null {
  return normalisePhone(`+${waId}`);
}
