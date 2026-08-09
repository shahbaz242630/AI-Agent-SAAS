import { describe, expect, it } from "vitest";
import { displayNameFrom, firstNameFrom, initialsFrom, roleLabel } from "@/lib/identity";

/**
 * The sidebar's avatar discs and greeting (2026-08-09 design handoff).
 *
 * ⚠️ NOTHING IN SIGN-UP ASKS FOR A NAME. Supabase gives us an email and a user
 * id, so every one of these has to produce something sensible from an address
 * alone — and none of them may return an empty string. An initials disc with
 * nothing in it reads as a rendering fault, and "Morning, ." reads as a bug on
 * the first screen of the product.
 */

describe("initials for an avatar disc", () => {
  it("takes one letter from each of the first two words", () => {
    expect(initialsFrom("Alpha Trading")).toBe("AT");
    expect(initialsFrom("Northgate Plumbing Services")).toBe("NP");
  });

  /** One letter in a 28px disc reads as a placeholder, not as a name. */
  it("takes two letters when there is only one word", () => {
    expect(initialsFrom("Eva")).toBe("EV");
  });

  /**
   * ⚠️ AN EMAIL IS NOT A NAME. Without cutting at the `@`,
   * "sam@northgate.co.uk" initials as "SN" — the S from the person and the N
   * from their email provider, which is nobody's initials.
   */
  it("never takes a letter from the email domain", () => {
    expect(initialsFrom("sam@northgate.co.uk")).toBe("SA");
    expect(initialsFrom("sam.okafor@northgate.co.uk")).toBe("SO");
  });

  it("splits on the punctuation email addresses actually use", () => {
    expect(initialsFrom("sam.okafor")).toBe("SO");
    expect(initialsFrom("sam_okafor")).toBe("SO");
    expect(initialsFrom("sam-okafor")).toBe("SO");
    expect(initialsFrom("sam+invoices@x.com")).toBe("SI");
  });

  /** Never empty: a blank disc looks broken, a "?" looks like missing data. */
  it("returns something rather than nothing when there is nothing", () => {
    expect(initialsFrom("")).toBe("?");
    expect(initialsFrom("   ")).toBe("?");
    expect(initialsFrom("@northgate.co.uk")).toBe("?");
  });
});

describe("a name for someone who never gave us one", () => {
  it("makes a recognisable name out of an address", () => {
    expect(displayNameFrom("sam.okafor@northgate.co.uk")).toBe("Sam Okafor");
    expect(displayNameFrom("sam@northgate.co.uk")).toBe("Sam");
  });

  /** Trailing digits are address noise, never part of what to call someone. */
  it("drops the numbers people add to their addresses", () => {
    expect(displayNameFrom("sam.okafor2@x.com")).toBe("Sam Okafor");
  });

  it("falls back to the raw value rather than an empty string", () => {
    expect(displayNameFrom("")).toBe("?");
    expect(displayNameFrom("123@x.com")).toBe("123@x.com");
  });

  /** ⚠️ "Morning, ." is worse than no greeting, and this is screen one. */
  it("always gives the greeting a word to use", () => {
    expect(firstNameFrom("sam.okafor@northgate.co.uk")).toBe("Sam");
    expect(firstNameFrom("")).toBe("?");
    expect(firstNameFrom("   ")).toBe("?");
  });
});

describe("the role under the organisation name", () => {
  it("says a role key the way a person would", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("read_only")).toBe("Read only");
  });

  /**
   * ⚠️ DERIVED, NOT LOOKED UP. A hardcoded map of today's six roles would go
   * stale the day the API grows a seventh — and stale SILENTLY, showing a blank
   * or a raw key under the organisation name. Reshaping whatever arrives cannot
   * drift.
   */
  it("copes with a role nobody has written down here yet", () => {
    expect(roleLabel("credit_controller")).toBe("Credit controller");
    expect(roleLabel("")).toBe("Member");
  });
});
