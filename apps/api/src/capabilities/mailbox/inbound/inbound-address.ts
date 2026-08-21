import { randomInt } from "node:crypto";

/**
 * Building a customer's front-door address (Slice 3.1b, founder ruling 33).
 *
 * ⚠️ REAL PEOPLE READ THIS ADDRESS OFF A WEBSITE AND TYPE IT. Ruling 29 is that
 * the business puts ONE address on their site and on their lead forms, so this
 * is not an internal identifier that happens to be an email address — it is
 * public-facing copy. Everything below follows from that one fact.
 *
 * ⚠️ AND IT IS SPENT THE MOMENT IT IS ISSUED. It goes on a website, into a lead
 * form's settings, and into the address book of everyone who ever enquires.
 * There is no recall. Migration 0029 refuses to reissue one for that reason,
 * and it is why the shape had to be settled before the first was handed out.
 */

/**
 * The random half of the address, and the only thing standing between a
 * stranger and somebody else's lead book.
 *
 * ⚠️ SIX CHARACTERS, NOT FOUR, AND THE EXTRA TWO ARE NOT COSMETIC. The threat is
 * not idle curiosity: an address that can be guessed can be used to push
 * fabricated enquiries into a competitor's book, and once Eva is answering
 * (3.1c) those fabrications are answered in the customer's name, from the
 * customer's own mailbox. Nothing we control rate-limits the attempt — the mail
 * arrives at the provider, not at us — so the search space IS the defence.
 * Four characters is ~923 thousand; six is ~887 million, for two characters
 * more to type once.
 *
 * ⚠️ NO 0/O, NO 1/L/I. Somebody is going to read this off a screen and type it
 * into a web form. A character set that cannot be misread is worth more than
 * the five bits it costs.
 */
const TAIL_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const TAIL_LENGTH = 6;

/**
 * How much of the business name survives into the address. Long enough for
 * "smith-plumbing-and-heating", short enough that the whole local part stays
 * inside the 64 the database allows and a person stays willing to type it.
 */
const MAX_SLUG_LENGTH = 32;

/**
 * What an organisation whose name yields nothing typeable gets called.
 *
 * ⚠️ THIS IS NOT A DEFENSIVE FLOURISH — IT IS THE NON-LATIN CASE. An
 * organisation named in Arabic, Chinese or Greek slugs to the empty string, and
 * so does one called "!!!". They still need a front door, and it still has to
 * be typeable by whoever is enquiring. The random tail is what makes it theirs,
 * so `enquiries-7k2fq9` is a perfectly good address — it is only the
 * recognisable half that is lost, and a name we cannot transliterate honestly
 * is better dropped than mangled.
 */
const FALLBACK_SLUG = "enquiries";

/**
 * A business name reduced to the readable half of an address.
 *
 * Accents are folded rather than stripped (`Café Noir` → `cafe-noir`, not
 * `caf-noir`) because the customer has to recognise this as their own.
 */
export function slugForOrganisation(name: string): string {
  const folded = name
    .normalize("NFD")
    // Combining marks, left behind by NFD. Removing them turns é into e.
    // Written as escapes, not literal characters: this repository is edited
    // from PowerShell, which has silently rewritten non-ASCII bytes before.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Anything that is not a permitted character becomes a boundary, which
    // collapses below. `&`, spaces, apostrophes and full stops all land here.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Truncating can leave a trailing hyphen ("smith-plumbing-and-" at 19), and
  // the database CHECK refuses that shape. Trim AFTER cutting, not before.
  const truncated = folded.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");

  // Two characters is not a name, it is a typo waiting to happen. The database
  // floor is 3 for the whole local part, which the tail alone would satisfy —
  // this is the higher bar, deliberately.
  return truncated.length >= 2 ? truncated : FALLBACK_SLUG;
}

/** Six unguessable characters. `randomInt` is uniform; `Math.random` is not. */
export function randomTail(): string {
  let tail = "";
  for (let index = 0; index < TAIL_LENGTH; index += 1) {
    tail += TAIL_ALPHABET[randomInt(TAIL_ALPHABET.length)];
  }
  return tail;
}

/**
 * The local part of a fresh address for this organisation.
 *
 * Not the whole address: the domain comes from configuration and changes once
 * (ruling 34), so the two halves are assembled where the domain is known.
 */
export function newLocalPart(organisationName: string): string {
  return `${slugForOrganisation(organisationName)}-${randomTail()}`;
}

/**
 * The shape the database will accept, mirrored here so a bad address fails in
 * a test rather than at 2am against a CHECK constraint.
 *
 * ⚠️ KEEP THIS IN STEP WITH `inbound_addresses_local_part_check` (migration
 * 0029). It is the same rule written twice on purpose — the database is what
 * ENFORCES it, and this is what lets us prove the generator obeys it without a
 * database. If they ever disagree, the migration is right.
 */
export const LOCAL_PART_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidLocalPart(localPart: string): boolean {
  return LOCAL_PART_PATTERN.test(localPart) && localPart.length >= 3 && localPart.length <= 64;
}
