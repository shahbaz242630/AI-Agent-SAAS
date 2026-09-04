import { describe, expect, it } from "vitest";
import {
  E164_SHAPE,
  EMAIL_SHAPE,
  WA_ID_SHAPE,
  normaliseEmail,
  normalisePhone,
  normaliseWaId,
  phoneFromWaId,
} from "./handles.js";

/**
 * The shapes the database enforces, proven at the function that produces
 * them. Every accepted value below must satisfy the matching CHECK in
 * migration 0041; every refused value is one the CHECK would also refuse, so
 * a normaliser that let it through would fail the transaction it sits in.
 */
describe("normalising an email handle", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Jane.Smith@Example.COM ")).toBe("jane.smith@example.com");
  });

  it("refuses what is not an address, rather than storing a name as one", () => {
    expect(normaliseEmail("Nobody At All")).toBeNull();
    expect(normaliseEmail("jane@")).toBeNull();
    expect(normaliseEmail("jane@localhost")).toBeNull();
    expect(normaliseEmail("two@at@example.com")).toBeNull();
    expect(normaliseEmail("")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });

  it("produces only values the CHECK accepts", () => {
    for (const raw of ["A@B.CO", "x.y+z@sub.example.org"]) {
      expect(normaliseEmail(raw)).toMatch(EMAIL_SHAPE);
    }
  });
});

describe("normalising a phone handle", () => {
  it("keeps a number that names its country, stripping the punctuation", () => {
    expect(normalisePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalisePhone("+44 (7700) 900-123")).toBe("+447700900123");
    expect(normalisePhone("+971 50 000 1234")).toBe("+971500001234");
  });

  it("turns an international 00 prefix into the plus", () => {
    expect(normalisePhone("0044 7700 900123")).toBe("+447700900123");
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL. A national number is a different number in
   * every country; guessing one would have Eva message a stranger.
   */
  it("refuses a national number rather than guessing its country", () => {
    expect(normalisePhone("07700 900123")).toBeNull();
    expect(normalisePhone("7700900123")).toBeNull();
  });

  it("refuses junk", () => {
    expect(normalisePhone("+0 123 456 789")).toBeNull();
    expect(normalisePhone("+44 12")).toBeNull();
    expect(normalisePhone("+447700900123456789")).toBeNull();
    expect(normalisePhone("call me")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });

  it("produces only values the CHECK accepts", () => {
    expect(normalisePhone("+44 7700 900123")).toMatch(E164_SHAPE);
    expect(normalisePhone("0044 7700 900123")).toMatch(E164_SHAPE);
  });
});

describe("a WhatsApp id", () => {
  it("is the E.164 digits without the plus, and nothing else", () => {
    expect(normaliseWaId("447911123456")).toBe("447911123456");
    expect(normaliseWaId(" 447911123456 ")).toBe("447911123456");
    expect(normaliseWaId("+447911123456")).toBeNull();
    expect(normaliseWaId("wamid.abc")).toBeNull();
    expect(normaliseWaId("12345")).toBeNull();
    expect(normaliseWaId(null)).toBeNull();
    expect(normaliseWaId("447911123456")).toMatch(WA_ID_SHAPE);
  });

  it("names its own country, so the phone handle needs no lookup", () => {
    expect(phoneFromWaId("447911123456")).toBe("+447911123456");
    expect(phoneFromWaId("971500001234")).toBe("+971500001234");
  });

  it("gives no phone handle for an id that is not a dialable number", () => {
    expect(phoneFromWaId("0123456789")).toBeNull();
  });
});
