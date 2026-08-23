import { describe, expect, it } from "vitest";
import {
  isConfirmationUrl,
  isForwardingConfirmation,
  readForwardingConfirmation,
  type InboundMessageShape,
} from "./gmail-forwarding-confirmation.js";

/**
 * Reading Google's forwarding confirmation (Slice 3.1b, step 4).
 *
 * ⚠️ THE FIXTURES BELOW ARE COPIED FROM TWO REAL ARCHIVED GOOGLE MESSAGES, NOT
 * COMPOSED HERE. Every fixture an author invents agrees with the parser that
 * same author wrote — that is exactly how #104 shipped a lead with no name and
 * how #110 shipped a mailbox that could not send, both with a full green suite.
 * The wording, the two subject orderings, the `vf-`/`uf-` pair and the token
 * shape are all as Google actually sends them.
 *
 * ⚠️ WHAT THESE TESTS STILL CANNOT PROVE is that fetching the `vf-` link is
 * what completes the confirmation at Google's end. No test here has ever spoken
 * to Google. That claim needs one real forwarding request and is not made
 * anywhere in the code.
 */

/**
 * The confirm and cancel links, one character apart.
 *
 * ⚠️ SYNTHETIC, THOUGH THE SHAPE IS COPIED FROM A REAL MESSAGE. The archived
 * example carried a genuine high-entropy Google token; pasting it into a
 * PUBLIC repository is how a test fixture becomes a secret-scanner finding,
 * and "it expired years ago" is not a thing this project should be arguing
 * about in a security check. What the parser actually cares about is
 * preserved: the `%40` encoding, the hyphenated segments and the length.
 */
const TOKEN = "0000000000-example-list%40example.org-AAAAA-bbbbbbbbbbbbbbbbbbbbbb";
const CONFIRM = `https://mail.google.com/mail/vf-${TOKEN}`;
const CANCEL = `https://mail.google.com/mail/uf-${TOKEN}`;

function googleMessage(over: Partial<InboundMessageShape> = {}): InboundMessageShape {
  return {
    from: "Gmail Team <forwarding-noreply@google.com>",
    subject: "(#33821484) Gmail Forwarding Confirmation - Receive Mail from durai145@gmail.com",
    text: [
      "durai145@gmail.com has requested to automatically forward mail to your",
      "email address shabby-plumbing-7k2fq9@drenadrene.resend.app.",
      "Confirmation code: 33821484",
      "",
      "To allow durai145@gmail.com to automatically forward mail to your address,",
      "please click the link below to confirm the request:",
      CONFIRM,
      "",
      "If you accidentally clicked the link, but you do not want to allow",
      "durai145@gmail.com to automatically forward messages to your address,",
      "click this link to cancel this verification:",
      CANCEL,
      "",
      "Thank you,",
      "The Gmail Team",
    ].join("\n"),
    html: `<p>durai145@gmail.com has requested to automatically forward mail to your email address shabby-plumbing-7k2fq9@drenadrene.resend.app.</p><p>Confirmation code: 33821484</p><a href="${CONFIRM}">Confirm</a><a href="${CANCEL}">Cancel</a>`,
    ...over,
  };
}

describe("Gmail forwarding confirmation — recognising one", () => {
  it("knows Google's confirmation email by its sender", () => {
    expect(isForwardingConfirmation(googleMessage())).toBe(true);
  });

  it("does not mistake an ordinary enquiry for one", () => {
    expect(
      isForwardingConfirmation({
        from: "Jane Smith <jane@example.com>",
        subject: "Gmail Forwarding Confirmation - can you quote for a new boiler?",
        text: `Please confirm at ${CONFIRM}`,
        html: null,
      }),
    ).toBe(false);
  });

  /**
   * ⚠️ THE DISPLAY NAME IS NOT THE SENDER, AND THIS IS THE CASE THAT COSTS AN
   * ENQUIRY. Anyone may call themselves "Gmail Team"; matching on the name
   * would let a stranger's genuine enquiry be swallowed as a robot's paperwork
   * and never reach the customer's book, with nothing failing to say so.
   */
  it("reads the address, never the display name", () => {
    expect(
      isForwardingConfirmation(
        googleMessage({ from: '"Gmail Team <forwarding-noreply@google.com>" <spoof@evil.test>' }),
      ),
    ).toBe(false);
  });
});

describe("Gmail forwarding confirmation — reading one", () => {
  it("reads who asked, the code and the confirmation link", () => {
    expect(readForwardingConfirmation(googleMessage())).toEqual({
      sourceAddress: "durai145@gmail.com",
      code: "33821484",
      confirmUrl: CONFIRM,
    });
  });

  /**
   * The archives carry both orderings — `(#code) Gmail Forwarding
   * Confirmation …` and `Gmail Forwarding Confirmation (#code) …` — so nothing
   * may anchor on where in the subject the code sits.
   */
  it("reads the code from either subject ordering", () => {
    const other = googleMessage({
      subject: "Gmail Forwarding Confirmation (#99427480) - Receive Mail from bjs3141@example.com",
    });
    expect(readForwardingConfirmation(other)).toMatchObject({
      sourceAddress: "bjs3141@example.com",
      code: "99427480",
    });
  });

  /**
   * ⚠️ THE ONE THAT MATTERS MOST IN THIS FILE. `vf-` confirms and `uf-`
   * cancels: same host, same path, same token, one character apart. Following
   * the wrong one throws away the forwarding the customer just asked for while
   * every status code reports success — they would be told their enquiries are
   * flowing and nothing would ever arrive.
   */
  it("never offers the cancel link, even when it is the only Google link present", () => {
    const cancelOnly = googleMessage({
      text: `click this link to cancel this verification:\n${CANCEL}`,
      html: `<a href="${CANCEL}">Cancel</a>`,
    });
    expect(readForwardingConfirmation(cancelOnly)?.confirmUrl).toBeNull();
  });

  it("still reads who asked and the code when no link can be found", () => {
    expect(
      readForwardingConfirmation(
        googleMessage({ text: "Confirmation code: 33821484", html: null }),
      ),
    ).toEqual({ sourceAddress: "durai145@gmail.com", code: "33821484", confirmUrl: null });
  });

  /**
   * ⚠️ PLAIN-TEXT BODIES WRAP AT ABOUT 78 CHARACTERS AND THIS URL IS LONGER.
   * A text-only read would take the first line and hand back a truncated link
   * that `isConfirmationUrl` accepts — right host, right prefix, wrong token —
   * so the confirmation would fail at Google for a reason nothing here reports.
   * The href in the HTML half cannot wrap, which is why it is read first.
   */
  it("prefers the unwrappable HTML link when the text copy has been wrapped", () => {
    const wrapped = googleMessage({
      text: `please click the link below to confirm the request:\nhttps://mail.google.com/mail/vf-0000000000-example-\nlist%40example.org-AAAAA-bbbbbbbbbbbbbbbbbbbbbb`,
    });
    expect(readForwardingConfirmation(wrapped)?.confirmUrl).toBe(CONFIRM);
  });

  it("strips the full stop a sentence leaves on the end of a link", () => {
    const punctuated = googleMessage({ html: null, text: `confirm the request: ${CONFIRM}.` });
    expect(readForwardingConfirmation(punctuated)?.confirmUrl).toBe(CONFIRM);
  });

  it("accepts the mail-settings host as well as the mail one", () => {
    const settingsHost = `https://mail-settings.google.com/mail/vf-${TOKEN}`;
    expect(
      readForwardingConfirmation(googleMessage({ html: `<a href="${settingsHost}">Confirm</a>` }))
        ?.confirmUrl,
    ).toBe(settingsHost);
  });

  /**
   * A request that cannot say who asked is a question the customer cannot
   * answer, so it is refused rather than filed against a guess. The caller
   * still refuses to make a lead from it — that decision belongs to
   * `isForwardingConfirmation`, which reads only the sender.
   */
  it("refuses to read a message that never names the requesting mailbox", () => {
    const anonymous = googleMessage({
      subject: "Gmail Forwarding Confirmation",
      text: "Confirmation code: 33821484",
      html: null,
    });
    expect(readForwardingConfirmation(anonymous)).toBeNull();
  });

  it("is not fooled into reading an ordinary enquiry", () => {
    expect(
      readForwardingConfirmation({
        from: "jane@example.com",
        subject: "Receive Mail from jane@example.com",
        text: "jane@example.com has requested to automatically forward mail to you",
        html: null,
      }),
    ).toBeNull();
  });
});

/**
 * ⚠️ THE MESSAGE GOOGLE ACTUALLY SENT US, 2026-08-22 17:59:00Z.
 *
 * A real forwarding request from `shahbaz.malik242630@gmail.com` to the test
 * organisation's live intake address, pulled out of Resend and pasted here
 * verbatim — line breaks included. It differs from the archived examples above
 * in three ways that each break something written from memory:
 *
 *   1. ⚠️ THERE IS NO CONFIRMATION CODE. Not in the subject, not in the body.
 *      The design this file was written against assumed the screen could fall
 *      back to "paste this code into Gmail"; there is no code to paste, so the
 *      only fallback is the link itself.
 *   2. ⚠️ THE SUBJECT CARRIES NO `(#code)` AND AN UNCLOSED BRACKET, and the
 *      separator is an EN DASH, not a hyphen. Anything anchored on that
 *      punctuation finds nothing.
 *   3. ⚠️ THERE IS NO HTML PART AT ALL — so the "prefer the href, it cannot
 *      wrap" reasoning has nothing to prefer, and the plain-text link is the
 *      only copy. It happens to arrive unwrapped despite the prose around it
 *      being wrapped at ~70 characters.
 *
 * The token below is SYNTHETIC: the real one is a live credential that would
 * let anyone confirm this forwarding, and this repository is public. What is
 * preserved is what the parser cares about — the host, the `vf-`/`uf-` prefix,
 * and the `%5B…%5D-` encoding around the payload.
 */
const REAL_TOKEN = "%5Bexample-payload-redacted%5D-example-tail";
const REAL_CONFIRM = `https://mail-settings.google.com/mail/vf-${REAL_TOKEN}`;
const REAL_CANCEL = `https://mail-settings.google.com/mail/uf-${REAL_TOKEN}`;

const REAL_MESSAGE: InboundMessageShape = {
  from: "forwarding-noreply@google.com",
  subject: "(Gmail Forwarding confirmation – Receive mail from shahbaz.malik242630@gmail.com",
  text: `shahbaz.malik242630@gmail.com has requested to automatically forward
mail to your email
address shahbaz-malik-test-account-dkf8np@drenadrene.resend.app.

To allow shahbaz.malik242630@gmail.com to automatically forward mail
to your address,
please click the link below to confirm the request:

${REAL_CONFIRM}

If you click the link and it appears to be broken, please copy and paste it
into a new browser window.

Thanks for using Gmail.

Sincerely,

The Gmail team

If you do not approve of this request, no further action is required.
shahbaz.malik242630@gmail.com cannot automatically forward messages to
your email address
unless you confirm the request by clicking the link above. If you accidentally
clicked the link, but you do not want to allow shahbaz.malik242630@gmail.com to
automatically forward messages to your address, click this link to cancel this
verification:
${REAL_CANCEL}

To learn more about why you might have received this message, please
visit: http://support.google.com/mail/bin/answer.py?answer=184973.

Please do not respond to this message.`,
  html: null,
};

describe("Gmail forwarding confirmation — the message Google really sent", () => {
  it("is recognised as a confirmation and never as an enquiry", () => {
    expect(isForwardingConfirmation(REAL_MESSAGE)).toBe(true);
  });

  it("reads the requesting mailbox out of a subject with no code in it", () => {
    expect(readForwardingConfirmation(REAL_MESSAGE)).toEqual({
      sourceAddress: "shahbaz.malik242630@gmail.com",
      /**
       * ⚠️ NULL, AND THAT IS THE REAL BEHAVIOUR RATHER THAN A GAP. Google no
       * longer sends a confirmation code. Any screen offering "paste this code
       * into Gmail" as its fallback would be offering something that does not
       * exist.
       */
      code: null,
      confirmUrl: REAL_CONFIRM,
    });
  });

  /**
   * The cancel link sits nine lines below the confirm link in this very
   * message. Picking "the Google link" would be a coin flip on a real
   * customer's forwarding.
   */
  it("picks the confirm link out of a body that contains both", () => {
    expect(REAL_MESSAGE.text).toContain(REAL_CANCEL);
    expect(readForwardingConfirmation(REAL_MESSAGE)?.confirmUrl).not.toContain("/mail/uf-");
  });

  it("is willing to fetch the link it found", () => {
    expect(isConfirmationUrl(REAL_CONFIRM)).toBe(true);
  });
});

/**
 * ⚠️ THIS IS AN SSRF BOUNDARY. What it judges is a string a stranger put in an
 * email, and what happens on the far side of it is our server making a request
 * from inside our own network.
 */
describe("Gmail forwarding confirmation — what we are willing to fetch", () => {
  it("accepts Google's own confirmation endpoints", () => {
    expect(isConfirmationUrl(CONFIRM)).toBe(true);
    expect(isConfirmationUrl(`https://mail-settings.google.com/mail/vf-${TOKEN}`)).toBe(true);
  });

  it.each([
    ["the cancel endpoint", CANCEL],
    ["plain http", `http://mail.google.com/mail/vf-${TOKEN}`],
    ["a lookalike prefix", `https://evil-mail.google.com/mail/vf-${TOKEN}`],
    ["a lookalike suffix", `https://mail.google.com.evil.test/mail/vf-${TOKEN}`],
    ["a userinfo trick", `https://mail.google.com@evil.test/mail/vf-${TOKEN}`],
    ["another path on the right host", "https://mail.google.com/mail/u/0/"],
    ["something that is not a URL at all", "vf-not-a-url"],
    ["the loopback interface", `https://127.0.0.1/mail/vf-${TOKEN}`],
  ])("refuses %s", (_label, candidate) => {
    expect(isConfirmationUrl(candidate)).toBe(false);
  });
});
