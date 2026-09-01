import { describe, expect, it } from "vitest";
import {
  composeReply,
  replySubject,
} from "../src/products/lead-follow-up-email/reply/compose-reply.js";

/**
 * The message Eva actually sends back (slice 3.1c-3).
 *
 * ⚠️ EVERY INPUT HERE IS ATTACKER-CONTROLLED. A stranger chooses the subject of
 * the mail they send and the address it claims to come from, and both end up in
 * a message that leaves the CUSTOMER'S mailbox in the CUSTOMER'S name. That is
 * why the injection cases below are tested as hard as the ordinary ones.
 */
describe("Composing the reply", () => {
  describe("the subject — how the reply threads", () => {
    it("prefixes a plain subject", () => {
      expect(replySubject("Leaking tap")).toBe("Re: Leaking tap");
    });

    /**
     * ⚠️ THE STACKING CASE, AND IT IS THE ORDINARY ONE FOR THIS PRODUCT. A
     * customer forwards an enquiry in (ruling 26's Gmail filter), so subjects
     * routinely arrive already carrying `Re:` or `Fwd:`. Prefixing blindly
     * gives `Re: Re: Fwd: Re: leaking tap`, which is what a broken mailing list
     * looks like — on a stranger's first impression of the business.
     */
    it("does not stack Re: on something that is already a reply", () => {
      expect(replySubject("Re: Leaking tap")).toBe("Re: Leaking tap");
      expect(replySubject("RE: Leaking tap")).toBe("RE: Leaking tap");
      expect(replySubject("re : Leaking tap")).toBe("re : Leaking tap");
    });

    it("strips forward markers, however many there are", () => {
      expect(replySubject("Fwd: Leaking tap")).toBe("Re: Leaking tap");
      expect(replySubject("Fw: Fwd: Leaking tap")).toBe("Re: Leaking tap");
      expect(replySubject("FWD: FWD: Leaking tap")).toBe("Re: Leaking tap");
    });

    it("handles a forwarded reply", () => {
      expect(replySubject("Fwd: Re: Leaking tap")).toBe("Re: Leaking tap");
    });

    /**
     * ⚠️ NOT "Re: (no subject)". A stranger reads this in their inbox and it
     * should look like a person answering, not like a form.
     */
    it("falls back to a readable subject when there was none", () => {
      expect(replySubject(null)).toBe("Thanks for your enquiry");
      expect(replySubject("")).toBe("Thanks for your enquiry");
      expect(replySubject("   ")).toBe("Thanks for your enquiry");
      // A subject that is nothing but forward markers is also no subject.
      expect(replySubject("Fwd: Fwd:")).toBe("Thanks for your enquiry");
    });

    /**
     * 🚨 HEADER INJECTION. A stranger controls this string, and on the Gmail
     * path it is composed into a raw RFC 5322 message where a newline can
     * append a `Bcc:` — silently copying the customer's mail to somebody else.
     * `rfc822.ts` guards its own path; this guard exists because the MICROSOFT
     * path never had to, so it cannot live only in the Google adapter.
     */
    it("flattens a subject carrying newlines", () => {
      const attack = "Leaking tap\r\nBcc: attacker@example.com";
      const subject = replySubject(attack);
      expect(subject).not.toContain("\r");
      expect(subject).not.toContain("\n");
      expect(subject).toBe("Re: Leaking tap Bcc: attacker@example.com");
    });

    it("caps a subject a stranger made enormous", () => {
      const subject = replySubject("x".repeat(5000));
      expect(subject.length).toBeLessThanOrEqual(200);
      expect(subject.startsWith("Re: ")).toBe(true);
    });

    it("leaves a localised prefix alone rather than guessing", () => {
      // `AW:` is German for `Re:`. Stripping a long tail of localised prefixes
      // means guessing, and guessing wrong mangles a real subject.
      expect(replySubject("AW: Leaking tap")).toBe("Re: AW: Leaking tap");
    });
  });

  describe("the whole message", () => {
    const enquiry = { contactEmail: "jane@example.com", originalSubject: "Leaking tap" };
    const template = "Thanks for getting in touch — we have your enquiry.";

    it("sends the customer's wording, verbatim", () => {
      const result = composeReply(enquiry, template);
      expect(result.composed).toBe(true);
      if (!result.composed) return;
      expect(result.reply.bodyText).toBe(template);
      expect(result.reply.to).toBe("jane@example.com");
      expect(result.reply.subject).toBe("Re: Leaking tap");
    });

    /**
     * ⚠️ EVA WRITES NOTHING, AND THIS IS THE TEST THAT KEEPS IT TRUE. Under
     * PECR the line between "technical delivery" and "instigating" a message
     * turns on who composed it — and a company was fined £105,000 in January
     * 2026 arguing it only sent on a client's behalf. If a future change starts
     * adding a greeting, a signature or a sign-off here, this fails.
     */
    it("adds nothing of its own to the body", () => {
      const result = composeReply(enquiry, template);
      if (!result.composed) throw new Error("expected a composed reply");
      expect(result.reply.bodyText).toHaveLength(template.length);
    });

    it("trims surrounding whitespace but keeps the shape of the wording", () => {
      const multiline = "\n  Line one.\n\n  Line two.\n  ";
      const result = composeReply(enquiry, multiline);
      if (!result.composed) throw new Error("expected a composed reply");
      expect(result.reply.bodyText).toBe("Line one.\n\n  Line two.");
      expect(result.reply.bodyText).toContain("\n\n");
    });

    describe("refusing, with a reason a customer can act on", () => {
      it("refuses when there is no address", () => {
        for (const contactEmail of ["", "   ", "not-an-address"]) {
          const result = composeReply({ contactEmail, originalSubject: null }, template);
          expect(result.composed, contactEmail).toBe(false);
          if (result.composed) return;
          expect(result.reason).toContain("no address");
        }
      });

      /**
       * 🚨 REFUSED, NOT STRIPPED — the opposite call from the subject, on
       * purpose. A newline in the recipient can append `Bcc:`, and unlike a
       * subject there is no benign reason for one. A mangled address sends
       * nowhere useful anyway, so failing loudly costs nothing.
       */
      it("refuses a recipient carrying a newline", () => {
        const result = composeReply(
          { contactEmail: "jane@example.com\r\nBcc: attacker@example.com", originalSubject: null },
          template,
        );
        expect(result.composed).toBe(false);
      });

      it("refuses an empty wording rather than sending a blank message", () => {
        const result = composeReply(enquiry, "   \n  ");
        expect(result.composed).toBe(false);
        if (result.composed) return;
        expect(result.reason).toContain("empty");
      });
    });

    /** Every refusal is a sentence, not a code — the enquiry screen shows it. */
    it("explains every refusal in words", () => {
      const refusals = [
        composeReply({ contactEmail: "", originalSubject: null }, template),
        composeReply({ contactEmail: "a@b.com\nBcc: x", originalSubject: null }, template),
        composeReply({ contactEmail: "a@b.com", originalSubject: null }, ""),
      ];
      for (const result of refusals) {
        expect(result.composed).toBe(false);
        if (result.composed) continue;
        expect(result.reason).toMatch(/^[a-z]/);
        expect(result.reason.length).toBeGreaterThan(15);
        expect(result.reason).not.toMatch(/[A-Z]{3,}|_/);
      }
    });
  });
});
