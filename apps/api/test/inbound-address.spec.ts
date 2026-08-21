import { describe, expect, it } from "vitest";
import {
  isValidLocalPart,
  newLocalPart,
  randomTail,
  slugForOrganisation,
} from "../src/capabilities/mailbox/inbound/inbound-address.js";

/**
 * The front-door address generator (Slice 3.1b, founder ruling 33).
 *
 * ⚠️ THIS IS TESTED HARDER THAN ITS SIZE SUGGESTS BECAUSE AN ADDRESS CANNOT BE
 * TAKEN BACK. It is printed on the customer's website and typed by strangers;
 * migration 0029 refuses to reissue one. A generator bug does not produce a
 * retryable error, it produces a business publishing a broken address.
 *
 * Every case below is a way the output could be wrong while still looking
 * plausible in a code review.
 */
describe("The front-door address: the readable half", () => {
  it("folds accents rather than dropping the letters", () => {
    // `caf-noir` would be the result of stripping non-ASCII instead of
    // normalising it, and the customer has to recognise this as their own name.
    expect(slugForOrganisation("Café Noir")).toBe("cafe-noir");
  });

  it("turns punctuation into boundaries and collapses the runs", () => {
    expect(slugForOrganisation("Smith & Sons Ltd.")).toBe("smith-sons-ltd");
    expect(slugForOrganisation("A   B")).toBe("a-b");
    expect(slugForOrganisation("O'Brien Plumbing")).toBe("o-brien-plumbing");
  });

  it("never begins or ends on a hyphen", () => {
    expect(slugForOrganisation("  Hedges & Co.  ")).toBe("hedges-co");
    expect(slugForOrganisation("!!!Loud!!!")).toBe("loud");
  });

  /**
   * ⚠️ THE ORDER OF TRUNCATE AND TRIM, WHICH IS THE ONE THING HERE THAT LOOKS
   * INTERCHANGEABLE AND IS NOT.
   *
   * This name's slug is 33 characters with a hyphen at index 31, so cutting to
   * 32 lands exactly on it. Trimming BEFORE cutting leaves that hyphen at the
   * end — an address the database refuses outright
   * (`inbound_addresses_local_part_check`), discovered at the moment a real
   * customer first opens the screen.
   */
  it("does not leave a trailing hyphen behind when it truncates", () => {
    const name = `${"a".repeat(31)} b`;
    const slug = slugForOrganisation(name);
    expect(slug).toBe("a".repeat(31));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back for a name that yields nothing typeable", () => {
    // Non-Latin scripts slug to nothing. They still need a door, and a
    // transliteration we cannot do honestly is worse than a neutral word.
    expect(slugForOrganisation("株式会社")).toBe("enquiries");
    expect(slugForOrganisation("مؤسسة")).toBe("enquiries");
    expect(slugForOrganisation("")).toBe("enquiries");
    expect(slugForOrganisation("- - -")).toBe("enquiries");
    // One character is a typo waiting to happen; two is a real (if short) name.
    expect(slugForOrganisation("A")).toBe("enquiries");
    expect(slugForOrganisation("AB")).toBe("ab");
  });
});

describe("The front-door address: the unguessable half", () => {
  it("is six characters, and none of them can be misread", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const tail = randomTail();
      expect(tail).toHaveLength(6);
      // No 0/o, no 1/l/i — somebody is reading this off a screen and typing it.
      expect(tail).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
    }
  });

  /**
   * ⚠️ A CONSTANT TAIL WOULD PASS EVERY OTHER TEST IN THIS FILE. It is exactly
   * what a broken random source produces, and it would make every customer's
   * address guessable from any other customer's — the whole reason ruling 33
   * has a random half at all.
   */
  it("differs between calls", () => {
    const tails = new Set(Array.from({ length: 100 }, () => randomTail()));
    expect(tails.size).toBeGreaterThan(90);
  });
});

describe("The front-door address: what the database will accept", () => {
  /**
   * The generator and the CHECK constraint are the same rule written twice
   * (migration 0029 says which one wins). This is what keeps them in step
   * without needing a database to find out.
   */
  it("produces a local part the database accepts, for every awkward name", () => {
    const names = [
      "Smith Plumbing",
      "Café Noir",
      "Smith & Sons Ltd.",
      "O'Brien Plumbing",
      "株式会社",
      "مؤسسة",
      "",
      "A",
      "!!!",
      "- - -",
      "123",
      `${"a".repeat(31)} b`,
      "The Very Long Name Of A Business That Goes On And On And On Forever",
      "  leading and trailing  ",
      "MiXeD CaSe LTD",
      "tabs\tand\nnewlines",
      "emoji 🚚 haulage",
    ];
    for (const name of names) {
      const localPart = newLocalPart(name);
      expect(isValidLocalPart(localPart), `'${name}' produced '${localPart}'`).toBe(true);
    }
  });

  it("rejects the shapes the database would reject", () => {
    expect(isValidLocalPart("-leading")).toBe(false);
    expect(isValidLocalPart("trailing-")).toBe(false);
    expect(isValidLocalPart("double--hyphen")).toBe(false);
    expect(isValidLocalPart("Upper")).toBe(false);
    expect(isValidLocalPart("has.dot")).toBe(false);
    expect(isValidLocalPart("has+plus")).toBe(false);
    expect(isValidLocalPart("ab")).toBe(false);
    expect(isValidLocalPart("")).toBe(false);
    expect(isValidLocalPart("a".repeat(65))).toBe(false);
  });
});
