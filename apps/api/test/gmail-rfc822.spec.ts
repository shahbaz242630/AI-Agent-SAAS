import { describe, expect, it } from "vitest";
import {
  buildRfc822,
  encodeHeaderValue,
  sanitiseHeaderValue,
  toBase64Url,
} from "../src/capabilities/mailbox/google/rfc822.js";

/**
 * Composing the message Gmail wants (Slice 3.1b, step 3).
 *
 * ⚠️ THIS FILE EXISTS BECAUSE GMAIL MADE US A MAIL CLIENT. Microsoft takes
 * `{subject, body, toRecipients}` as JSON and composes the message itself;
 * Gmail takes one field holding an entire RFC 5322 email. Everything Graph did
 * for us — escaping, encoding, and refusing to let a value become a header — is
 * now ours, and each of those is a test below.
 */

describe("Gmail messages: header injection", () => {
  /**
   * ⚠️ THE ONLY GENUINELY DANGEROUS CASE HERE, AND IT DID NOT EXIST BEFORE.
   * Headers are separated by CRLF, so a newline inside a subject or recipient
   * appends headers of the attacker's choosing. `Bcc:` is the obvious one —
   * a silent copy of a customer's mail to a stranger — and Graph's JSON body
   * made it impossible. Composing our own message makes it possible.
   */
  it("never lets a value become a new header", () => {
    const injected = "Invoice 42\r\nBcc: attacker@example.com";
    expect(sanitiseHeaderValue(injected)).toBe("Invoice 42 Bcc: attacker@example.com");

    const message = buildRfc822({
      from: "eva@example.com",
      to: "debtor@example.com",
      subject: injected,
      bodyText: "hello",
    });
    const headerBlock = message.split("\r\n\r\n")[0]!;
    const bccLines = headerBlock.split("\r\n").filter((line) => line.startsWith("Bcc:"));
    expect(bccLines, "an injected Bcc must never become its own header").toEqual([]);
  });

  it("strips a newline smuggled through the recipient too", () => {
    const message = buildRfc822({
      to: "debtor@example.com\nBcc: attacker@example.com",
      subject: "Invoice 42",
      bodyText: "hello",
    });
    const headerBlock = message.split("\r\n\r\n")[0]!;
    expect(headerBlock.split("\r\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
  });

  it("handles bare newlines as well as CRLF", () => {
    expect(sanitiseHeaderValue("a\nb")).toBe("a b");
    expect(sanitiseHeaderValue("a\r\nb")).toBe("a b");
    expect(sanitiseHeaderValue("a\rb")).toBe("a b");
  });
});

describe("Gmail messages: characters a UK business actually uses", () => {
  /**
   * ⚠️ A BARE `£` IN A SUBJECT ARRIVES AS MOJIBAKE. Headers are ASCII by
   * specification. This project has already watched pound signs survive in the
   * code and die in transit, and "Invoice for Â£450" is a customer emailing
   * their own customer something visibly broken.
   */
  it("MIME-encodes a subject containing a pound sign", () => {
    const encoded = encodeHeaderValue("Invoice for £450 is overdue");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    // Decodes back to exactly what went in.
    const base64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(base64, "base64").toString("utf8")).toBe("Invoice for £450 is overdue");
  });

  it("leaves a plain ASCII subject alone, so ordinary mail stays readable", () => {
    expect(encodeHeaderValue("Invoice 42 is overdue")).toBe("Invoice 42 is overdue");
  });

  /**
   * The body is base64 with `Content-Transfer-Encoding: base64` rather than
   * raw UTF-8, because declaring a charset and then putting 8-bit bytes on the
   * wire trusts every hop to honour 8BITMIME. The ones that do not mangle
   * exactly these characters.
   */
  it("carries a pound sign and an em dash through the body intact", () => {
    const body = "You owe £1,250 — please pay by Friday.";
    const message = buildRfc822({ to: "a@b.com", subject: "x", bodyText: body });
    expect(message).toContain("Content-Transfer-Encoding: base64");

    const encodedBody = message.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(encodedBody, "base64").toString("utf8")).toBe(body);
  });

  it("wraps long bodies so a receiver cannot truncate them", () => {
    const message = buildRfc822({
      to: "a@b.com",
      subject: "x",
      bodyText: "z".repeat(5000),
    });
    const lines = message.split("\r\n\r\n")[1]!.split("\r\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

describe("Gmail messages: the envelope", () => {
  it("includes From when we know it", () => {
    const message = buildRfc822({
      from: "eva@example.com",
      to: "a@b.com",
      subject: "x",
      bodyText: "y",
    });
    expect(message).toContain("From: eva@example.com");
  });

  /**
   * ⚠️ ABSENT RATHER THAN GUESSED. Gmail fills in the authenticated user's
   * address and refuses to send as anybody else — so no header is correct,
   * while an invented one is the header a recipient reads to decide whether
   * the mail is genuine.
   */
  it("omits From entirely when we do not, rather than inventing one", () => {
    const message = buildRfc822({ to: "a@b.com", subject: "x", bodyText: "y" });
    const headerBlock = message.split("\r\n\r\n")[0]!;
    expect(headerBlock.split("\r\n").some((l) => l.startsWith("From:"))).toBe(false);
    expect(headerBlock).toContain("To: a@b.com");
  });

  /**
   * ⚠️ base64URL, NOT base64. Three characters different, and standard base64
   * is rejected with a 400 that says nothing about why.
   */
  it("encodes for the raw field with the URL alphabet and no padding", () => {
    // Chosen so standard base64 would contain both '+' and '/'.
    const encoded = toBase64Url("<<<???>>>~~~ÿÿ");
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe("<<<???>>>~~~ÿÿ");
  });

  it("separates headers from body with exactly one blank line", () => {
    const message = buildRfc822({ to: "a@b.com", subject: "x", bodyText: "y" });
    expect(message.split("\r\n\r\n")).toHaveLength(2);
  });
});
