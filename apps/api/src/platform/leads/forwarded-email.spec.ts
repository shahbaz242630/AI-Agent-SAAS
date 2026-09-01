import { describe, expect, it } from "vitest";
import { unwrapForwardedEmail } from "./forwarded-email.js";

/**
 * Reading a manually forwarded enquiry (slice 3.1c-0b).
 *
 * ⚠️ THE SHAPE UNDER TEST CAME OFF A REAL PRODUCTION LEAD, not from
 * imagination. On 2026-09-01 `lead_evidence.raw_excerpt` in production held:
 *
 *     This is test email 2\nKind Regards\n\nShahbaz Malik\n\nBegin forwarded
 *     message:\n\nFrom: Shahbaz ...
 *
 * — the forwarder's covering note first, the real message below a fold. Eva
 * filed the lead against the forwarder and quoted their note as the enquiry.
 *
 * ⚠️ HALF OF THESE TESTS ASSERT `null`, AND THAT IS THE POINT. Returning null
 * means "use the message as it arrived", which is the behaviour that shipped
 * and is never wrong — only unhelpful. Returning a WRONG parse hands Eva
 * somebody else's address to reply to. Every ambiguous case below must choose
 * null, and a future "improvement" that makes one of them parse is a
 * regression, not a feature.
 */
describe("unwrapForwardedEmail", () => {
  const APPLE = [
    "This is test email 2",
    "Kind Regards",
    "",
    "Shahbaz Malik",
    "",
    "Begin forwarded message:",
    "",
    "From: Jane Smith <jane@example.com>",
    "Date: 1 September 2026 at 10:04:11 BST",
    "To: mike@mikesplumbing.co.uk",
    "Subject: Leaking flat roof",
    "",
    "Hello, I found you online. The flat roof over my kitchen has been leaking.",
    "Could you take a look this week?",
  ].join("\n");

  it("reads the ORIGINAL sender, not the person who forwarded it", () => {
    expect(unwrapForwardedEmail(APPLE)?.from).toBe("Jane Smith <jane@example.com>");
  });

  it("reads the enquiry below the fold, not the covering note above it", () => {
    const body = unwrapForwardedEmail(APPLE)!.body;
    expect(body).toContain("The flat roof over my kitchen has been leaking");
    // The covering note and the header block are BOTH gone.
    expect(body).not.toContain("Kind Regards");
    expect(body).not.toContain("This is test email 2");
    expect(body).not.toContain("Subject: Leaking flat roof");
  });

  it("takes the forwarded subject, not the client's Fwd: version", () => {
    expect(unwrapForwardedEmail(APPLE)?.subject).toBe("Leaking flat roof");
  });

  it("reads Gmail's marker", () => {
    const gmail = [
      "see below",
      "",
      "---------- Forwarded message ---------",
      "From: Jane Smith <jane@example.com>",
      "Date: Mon, 1 Sep 2026 at 10:04",
      "Subject: Leaking flat roof",
      "To: <mike@mikesplumbing.co.uk>",
      "",
      "Hello, I found you online.",
    ].join("\n");
    expect(unwrapForwardedEmail(gmail)?.from).toBe("Jane Smith <jane@example.com>");
    expect(unwrapForwardedEmail(gmail)?.body).toBe("Hello, I found you online.");
  });

  it("reads Outlook's marker", () => {
    const outlook = [
      "-----Original Message-----",
      "From: Jane Smith <jane@example.com>",
      "Sent: 01 September 2026 10:04",
      "To: Mike",
      "Subject: Leaking flat roof",
      "",
      "Hello, I found you online.",
    ].join("\n");
    expect(unwrapForwardedEmail(outlook)?.from).toBe("Jane Smith <jane@example.com>");
  });

  it("copes with the block being quoted with >", () => {
    const quoted = [
      "fyi",
      "",
      "> Begin forwarded message:",
      ">",
      "> From: Jane Smith <jane@example.com>",
      "> Subject: Leaking flat roof",
      ">",
      "> Hello, I found you online.",
    ].join("\n");
    expect(unwrapForwardedEmail(quoted)?.from).toBe("Jane Smith <jane@example.com>");
    expect(unwrapForwardedEmail(quoted)?.body).toBe("Hello, I found you online.");
  });

  describe("refuses rather than guesses", () => {
    it("an ordinary enquiry is not a forward", () => {
      expect(unwrapForwardedEmail("Hello, my roof is leaking. Can you help?")).toBeNull();
    });

    /** ⚠️ A SENTENCE ABOUT FORWARDING IS PROSE, NOT A FOLD. The markers are
     *  anchored to a whole line for exactly this. */
    it("somebody writing the word forwarded is not a forward", () => {
      const prose = "I forwarded message after message to your old address and heard nothing.";
      expect(unwrapForwardedEmail(prose)).toBeNull();
    });

    it("a marker with no From: is refused", () => {
      const noFrom = ["Begin forwarded message:", "", "Subject: Roof", "", "Hello."].join("\n");
      expect(unwrapForwardedEmail(noFrom)).toBeNull();
    });

    /** ⚠️ THE ONE THAT MATTERS MOST. A display-name-only From would otherwise
     *  reach `contact_email` as a name, and Eva would have no address to reply
     *  to — or worse, try the name as one. */
    it("a From: with no address at all is refused", () => {
      const nameOnly = ["Begin forwarded message:", "", "From: Jane Smith", "", "Hello."].join(
        "\n",
      );
      expect(unwrapForwardedEmail(nameOnly)).toBeNull();
    });

    it("a fold with nothing under it is refused", () => {
      const empty = ["note", "", "Begin forwarded message:", "", "From: a@b.com", ""].join("\n");
      expect(unwrapForwardedEmail(empty)).toBeNull();
    });

    /** Prose between two headers means we are not reading a header block, and
     *  a "successful" parse of one would be a confident wrong answer. */
    it("prose interrupting the header block ends it, so a From: below is not used", () => {
      const interrupted = [
        "Begin forwarded message:",
        "",
        "this is not a header",
        "From: jane@example.com",
        "",
        "Hello.",
      ].join("\n");
      expect(unwrapForwardedEmail(interrupted)).toBeNull();
    });

    it("null and empty input are not forwards", () => {
      expect(unwrapForwardedEmail(null)).toBeNull();
      expect(unwrapForwardedEmail("")).toBeNull();
    });
  });
});
