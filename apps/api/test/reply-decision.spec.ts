import { describe, expect, it } from "vitest";
import { RuleBasedReplyDecisionProvider } from "../src/products/lead-follow-up/decision/rule-based-reply-decision.provider.js";
import type {
  EmailReplyDecisionInput,
  ReplyDecisionInput,
  WhatsAppReplyDecisionInput,
} from "../src/products/lead-follow-up/decision/reply-decision.js";

/**
 * Which enquiries Eva answers on her own (slice 3.1c-2, founder rulings 32 and 54).
 *
 * 🚨 THE POINT OF THIS FILE IS THE MAIL LOOP. Eva replies from the CUSTOMER'S
 * mailbox. If she answers an auto-responder, that machine answers her, and she
 * answers it again — on the customer's domain, in the customer's name, at the
 * customer's reputation. Every "never" case below is a documented way of
 * saying "a machine sent this", and each one is tested because a rule that
 * silently stops matching looks identical to a rule that was never needed.
 *
 * ⚠️ AND THE OPPOSITE FAILURE IS JUST AS EXPENSIVE. A rule that is too greedy
 * refuses a real enquiry, and a lost enquiry is a lost customer nobody ever
 * finds out about. So the false-positive cases are tested as hard as the true
 * ones — see "the ordinary enquiry" below.
 */
/** A WhatsApp input with the ordinary enquiry's values, overridden per case. */
function whatsapp(
  input: Partial<Omit<WhatsAppReplyDecisionInput, "channel">>,
): WhatsAppReplyDecisionInput {
  return {
    channel: "whatsapp",
    messageType: "text",
    forwarded: false,
    frequentlyForwarded: false,
    text: "Hi, can you quote for a new bathroom?",
    ...input,
  };
}

describe("Which enquiries Eva answers on her own", () => {
  const decide = (input: Partial<Omit<EmailReplyDecisionInput, "channel">> = {}) =>
    new RuleBasedReplyDecisionProvider().decide({
      channel: "email",
      headers: { "x-ses-spam-verdict": "PASS" },
      fromAddress: "jane@example.com",
      subject: "Leaking tap",
      body: "Hello, my kitchen tap is dripping. Could you take a look this week?",
      ...input,
    });

  /** Every genuine enquiry keeps its PASS verdict unless a test says otherwise. */
  const withHeaders = (headers: Record<string, string>) => ({
    headers: { "x-ses-spam-verdict": "PASS", ...headers },
  });

  describe("the ordinary enquiry — the case everything else must not break", () => {
    it("replies to a person asking about work", () => {
      const decision = decide();
      expect(decision.verdict).toBe("reply");
      expect(decision.signal).toBe("no-refusal");
    });

    /**
     * ⚠️ THE SUBJECT LINE IS NOT EVIDENCE, AND THIS IS THE TEST THAT KEEPS IT
     * THAT WAY. "out of office" in a subject is ordinary English and turns up
     * in real enquiries; only a header a machine sets about ITSELF means what
     * it says. A future "improvement" that reads the subject fails here.
     */
    it("replies even when the subject contains words an auto-responder would use", () => {
      for (const subject of [
        "Re: out of office cover — can you quote?",
        "Automatic gate repair",
        "Undelivered parcel damaged my fence, can you fix it?",
        "No reply from your last visit",
      ]) {
        expect(decide({ subject }).verdict, subject).toBe("reply");
      }
    });

    /**
     * ⚠️ AND THE ADDRESS MUST BE MATCHED PROPERLY, NOT WITH `includes`. These
     * are real local parts that contain a refused word as a substring; a naive
     * check would silently stop answering them.
     */
    it("replies to real addresses that merely contain a refused word", () => {
      for (const fromAddress of [
        "enquiries@example.com",
        "bouncycastles@example.com",
        "postmasterson@example.com",
        "reply.jane@example.com",
        "norman.replyton@example.com",
      ]) {
        expect(decide({ fromAddress }).verdict, fromAddress).toBe("reply");
      }
    });
  });

  describe("never — a machine sent it, and answering could start a loop", () => {
    it("refuses anything RFC 3834 marks as automatic", () => {
      for (const value of ["auto-replied", "auto-generated", "AUTO-REPLIED"]) {
        const decision = decide(withHeaders({ "auto-submitted": value }));
        expect(decision.verdict, value).toBe("never");
        expect(decision.signal).toBe("auto-submitted");
      }
    });

    /** `Auto-Submitted: no` is the header saying "a person sent this". */
    it("does NOT refuse when the header explicitly says it was not automatic", () => {
      expect(decide(withHeaders({ "auto-submitted": "no" })).verdict).toBe("reply");
    });

    it("refuses bulk, list and junk precedence", () => {
      for (const value of ["bulk", "list", "junk", "auto_reply", "BULK"]) {
        expect(decide(withHeaders({ precedence: value })).verdict, value).toBe("never");
      }
    });

    it("refuses mailing list mail on either list header", () => {
      expect(decide(withHeaders({ "list-id": "<news.example.com>" })).verdict).toBe("never");
      expect(decide(withHeaders({ "list-unsubscribe": "<mailto:x@example.com>" })).verdict).toBe(
        "never",
      );
    });

    it("refuses when the sender asked for no automatic replies", () => {
      expect(decide(withHeaders({ "x-auto-response-suppress": "OOF, AutoReply" })).verdict).toBe(
        "never",
      );
    });

    /**
     * ⚠️ THE NULL RETURN-PATH IS THE BOUNCE SIGNAL. RFC 5321 requires `<>` on a
     * delivery status notification precisely so answering one cannot bounce in
     * turn. Replying to a bounce is the purest form of the loop.
     */
    it("refuses a bounce, by null return-path or report content type", () => {
      expect(decide(withHeaders({ "return-path": "<>" })).verdict).toBe("never");
      expect(
        decide(withHeaders({ "content-type": "multipart/report; report-type=delivery-status" }))
          .verdict,
      ).toBe("never");
    });

    it("keeps replying to a normal return-path", () => {
      expect(decide(withHeaders({ "return-path": "<jane@example.com>" })).verdict).toBe("reply");
    });

    it("refuses addresses that do not accept replies", () => {
      for (const fromAddress of [
        "noreply@example.com",
        "no-reply@example.com",
        "donotreply@example.com",
        "MAILER-DAEMON@example.com",
        "postmaster@example.com",
        "bounces-12345@example.com",
        "no-reply.system@example.com",
      ]) {
        const decision = decide({ fromAddress });
        expect(decision.verdict, fromAddress).toBe("never");
        expect(decision.signal).toBe("unattended-sender");
      }
    });

    /**
     * ⚠️ "never", NOT "hold". A human reviewing this could not send a reply
     * either — there is nowhere for it to go. Parking it would ask somebody for
     * a decision with no available answer.
     */
    it("refuses when there is no address to reply to", () => {
      expect(decide({ fromAddress: "" }).verdict).toBe("never");
      expect(decide({ fromAddress: "not-an-address" }).signal).toBe("no-reply-address");
    });

    /** A refusal beats an uncertain spam verdict — order is not arbitrary. */
    it("refuses a bounce even when the spam verdict is also uncertain", () => {
      const decision = decide({
        headers: { "x-ses-spam-verdict": "GRAY", "return-path": "<>" },
      });
      expect(decision.verdict).toBe("never");
      expect(decision.signal).toBe("bounce");
    });
  });

  describe("hold — the uncertain middle waits for a human (ruling 32)", () => {
    it("holds when the provider was unsure it was junk", () => {
      const decision = decide(withHeaders({ "x-ses-spam-verdict": "GRAY" }));
      expect(decision.verdict).toBe("hold");
      expect(decision.reason).toContain("for you to read first");
    });

    /**
     * ⚠️ FAIL CLOSED ON "NOBODY CHECKED". A missing header is not a pass; it
     * means no scan happened, and treating that as fine is how an automatic
     * reply goes out to something nothing ever looked at.
     */
    it("holds when nothing scanned it at all", () => {
      expect(decide({ headers: {} }).verdict).toBe("hold");
      expect(decide(withHeaders({ "x-ses-spam-verdict": "PROCESSING_FAILED" })).verdict).toBe(
        "hold",
      );
      expect(decide(withHeaders({ "x-ses-spam-verdict": "nonsense" })).verdict).toBe("hold");
    });

    /**
     * ⚠️ HOLD IS NOT NEVER, AND THE DIFFERENCE IS THE WHOLE OF RULING 32. A
     * held enquiry is still in the book with a person expected to read it; a
     * refused one is closed. Collapsing them would either bin real work or ask
     * somebody to review bounces forever.
     */
    it("is a different outcome from a refusal", () => {
      expect(decide(withHeaders({ "x-ses-spam-verdict": "GRAY" })).verdict).not.toBe("never");
    });
  });

  /**
   * 🔑 THE WHATSAPP ARM (slice 3.4a) — its own signals, not email's squinted
   * at. There is no loop to prevent and no spam verdict to read; what can go
   * wrong is answering something that was never a request.
   */
  describe("on WhatsApp — a different medium, a different list", () => {
    const decideWhatsApp = (input: Partial<Omit<WhatsAppReplyDecisionInput, "channel">> = {}) =>
      new RuleBasedReplyDecisionProvider().decide(whatsapp(input));

    it("replies to a text, a photo, a location, a contact card, a tapped button and an ad's welcome", () => {
      for (const messageType of [
        "text",
        "image",
        "audio",
        "video",
        "document",
        "sticker",
        "location",
        "contacts",
        "interactive",
        "button",
        "order",
        "request_welcome",
      ]) {
        const decision = decideWhatsApp({
          messageType,
          text: messageType === "text" ? "Hi" : null,
        });
        expect(decision.verdict, messageType).toBe("reply");
        expect(decision.signal).toBe("no-refusal");
      }
    });

    /** A type Meta adds tomorrow is still a person reaching out. */
    it("replies to a message type it has never heard of", () => {
      expect(decideWhatsApp({ messageType: "hologram" }).verdict).toBe("reply");
    });

    it("never answers a reaction — a thumbs-up is not a message", () => {
      const decision = decideWhatsApp({ messageType: "reaction", text: null });
      expect(decision.verdict).toBe("never");
      expect(decision.signal).toBe("reaction");
    });

    it("never answers a system notice about the account", () => {
      const decision = decideWhatsApp({ messageType: "system", text: "changed their number" });
      expect(decision.verdict).toBe("never");
      expect(decision.signal).toBe("system-notice");
    });

    it("holds content WhatsApp could not pass on, for a person to look at", () => {
      const decision = decideWhatsApp({ messageType: "unsupported", text: null });
      expect(decision.verdict).toBe("hold");
      expect(decision.signal).toBe("unsupported-content");
    });

    /**
     * ⚠️ `frequently_forwarded`, NOT `forwarded`. A person passing on their
     * partner's photo of the leak is an enquiry; a chain message is not. The
     * two flags are tested apart so a "tidy" merge of them fails here.
     */
    it("holds a chain message, and still replies to an ordinary forward", () => {
      const chain = decideWhatsApp({ forwarded: true, frequentlyForwarded: true });
      expect(chain.verdict).toBe("hold");
      expect(chain.signal).toBe("chain-message");

      const forward = decideWhatsApp({ forwarded: true, frequentlyForwarded: false });
      expect(forward.verdict).toBe("reply");
    });

    /**
     * ⚠️ THE WORDS ARE NOT READ, AND THIS IS THE TEST THAT KEEPS IT THAT WAY.
     * "STOP" is the engine's business (3.5): it cancels nudges and writes a
     * consent event. An acknowledgement of a fresh enquiry is not a nudge, and
     * a rule that read the text here would be the wrong place to grow opt-out
     * handling — half of it, silently, on one channel.
     */
    it("does not decide by the words", () => {
      for (const text of ["STOP", "unsubscribe", "out of office", "auto-reply"]) {
        expect(decideWhatsApp({ text }).verdict, text).toBe("reply");
      }
    });

    /** The email rules must not have quietly started applying to WhatsApp, or the reverse. */
    it("keeps the two lists apart", () => {
      // An email-only signal cannot arise from a WhatsApp input at all — the
      // type forbids it — so the check is the other way: every WhatsApp
      // signal names a WhatsApp thing.
      for (const input of [
        whatsapp({ messageType: "reaction" }),
        whatsapp({ messageType: "system" }),
        whatsapp({ messageType: "unsupported" }),
        whatsapp({ frequentlyForwarded: true }),
      ]) {
        const decision = new RuleBasedReplyDecisionProvider().decide(input);
        expect(decision.signal).not.toMatch(/auto-submitted|bounce|mailing-list|spam-verdict/);
      }
    });
  });

  describe("the header reading itself", () => {
    /**
     * ⚠️ CASING MUST NOT DISABLE A RULE. Intake lower-cases header names today;
     * a provider that changes that would otherwise turn every rule off at once,
     * with nothing failing anywhere — the `spam-verdict.ts` lesson, one layer up.
     */
    it("reads headers whatever case they arrive in", () => {
      expect(
        decide({
          headers: { "X-SES-Spam-Verdict": "PASS", "Auto-Submitted": "auto-replied" },
          fromAddress: "jane@example.com",
        }).verdict,
      ).toBe("never");
    });

    it("ignores an empty header rather than treating it as present", () => {
      expect(decide(withHeaders({ "list-id": "   " })).verdict).toBe("reply");
    });
  });

  /**
   * ⚠️ EVERY VERDICT CARRIES A SENTENCE A CUSTOMER CAN READ. The reason is
   * shown on the enquiry screen to explain why nothing was sent; a signal key
   * leaking into it would ask a plumber to interpret `AUTO_SUBMITTED_HEADER`.
   * This project has shipped copy nobody could read twice already.
   */
  describe("what it tells the customer", () => {
    const cases: ReplyDecisionInput[] = [
      { channel: "email", headers: {}, fromAddress: "jane@example.com", subject: null, body: "" },
      {
        channel: "email",
        headers: { "x-ses-spam-verdict": "PASS", "auto-submitted": "auto-replied" },
        fromAddress: "jane@example.com",
        subject: null,
        body: "",
      },
      {
        channel: "email",
        headers: { "x-ses-spam-verdict": "PASS" },
        fromAddress: "noreply@example.com",
        subject: null,
        body: "",
      },
      // The WhatsApp arm (3.4a): one of each verdict.
      whatsapp({}),
      whatsapp({ messageType: "reaction" }),
      whatsapp({ frequentlyForwarded: true }),
      whatsapp({ messageType: "unsupported" }),
    ];

    it("explains itself in words, not in codes", () => {
      for (const input of cases) {
        const decision = new RuleBasedReplyDecisionProvider().decide(input);
        expect(decision.reason).toMatch(/^[a-z]/);
        expect(decision.reason.length).toBeGreaterThan(20);
        expect(decision.reason).not.toMatch(/[A-Z]{3,}|_/);
        expect(decision.signal).toMatch(/^[a-z0-9-]+$/);
      }
    });
  });
});
