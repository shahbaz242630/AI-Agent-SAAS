import { describe, expect, it } from "vitest";
import { FORWARDING_ARMED_WINDOW_MINUTES } from "@eva/types";
import {
  GMAIL_FORWARDING_STEPS,
  armedWindowSentence,
  unexpectedRequestSentence,
} from "../src/capabilities/mailbox/forwarding-guide";

/**
 * The words a customer follows to point Gmail at Eva (Slice 3.1b, step 4).
 *
 * ⚠️ COPY THAT NO TEST PINS IS COPY THAT CAN SILENTLY DEGRADE — #109's lesson,
 * where seven customer-facing sentences became untrue in one slice and 925
 * tests, both walls and CodeQL all stayed green because none of them read a
 * word of it. These are instructions for somebody standing in a screen we do
 * not control, so every sentence below is load-bearing: get one wrong and the
 * customer is stuck somewhere we cannot see.
 */

describe("The Gmail forwarding guide", () => {
  /**
   * ⚠️ THE STEP THE FOUNDER ACTUALLY GOT STUCK ON, 2026-08-22. Gmail's
   * forwarding pane sometimes draws from a stale copy and shows a plain text
   * box where the button should be; typing the address into it fails with
   * "Invalid forwarding address", and then a banner appears claiming the
   * forwarding IS set up. Both are wrong and a reload fixes it. Without this
   * sentence the customer's first move is the one that cannot work.
   */
  it("warns about the stale Gmail screen on the step where it bites", () => {
    const step = GMAIL_FORWARDING_STEPS.find((candidate) =>
      candidate.instruction.includes("Add a forwarding address"),
    );
    expect(step?.warning).toMatch(/reload/i);
    expect(step?.warning).toMatch(/invalid forwarding address/i);
  });

  /**
   * ⚠️ CONFIRMING THE ADDRESS IS NOT SWITCHING FORWARDING ON, AND THIS PROJECT
   * PROVED IT ON ITSELF. On 2026-08-22 the address was confirmed against real
   * Google and Gmail still forwarded nothing, because the radio button had
   * never been saved. A guide that stopped at "confirmed" would leave every
   * customer in that state — set up, verified, and silent.
   */
  it("does not stop at confirmed, and says which step actually starts the mail", () => {
    const last = GMAIL_FORWARDING_STEPS.at(-1);
    expect(last?.instruction).toMatch(/save changes/i);
    expect(last?.warning).toMatch(/nothing is forwarded/i);
  });

  /**
   * ⚠️ GOOGLE STOPPED SENDING A CONFIRMATION CODE. Measured on the real
   * message: there is none in the subject or the body. Any step promising one —
   * or telling the customer to go and find one — would send them looking for
   * something that does not exist.
   */
  it("never promises a confirmation code, because there is not one", () => {
    for (const step of GMAIL_FORWARDING_STEPS) {
      expect(`${step.instruction} ${step.warning ?? ""}`).not.toMatch(/confirmation code/i);
    }
  });

  /** The promise the whole feature is for, said once and plainly. */
  it("tells the customer they will not need the code", () => {
    const all = GMAIL_FORWARDING_STEPS.map((step) => step.instruction).join(" ");
    expect(all).toMatch(/never need the code/i);
  });

  /**
   * ⚠️ ONE NUMBER, FROM THE SHARED KERNEL. The API enforces this window and the
   * screen states it. Two copies is a sentence promising half an hour while the
   * server allows ten minutes, with nothing failing anywhere.
   */
  it("states the same window the API enforces", () => {
    expect(armedWindowSentence(FORWARDING_ARMED_WINDOW_MINUTES)).toContain(
      `${FORWARDING_ARMED_WINDOW_MINUTES} minutes`,
    );
  });
});

describe("A forwarding request nobody asked for", () => {
  /**
   * ⚠️ THIS SENTENCE IS THE SECURITY MODEL IN PLAIN ENGLISH, AND SOFTENING IT
   * INTO "just checking" IS THE FAILURE MODE. If it was not them, somebody has
   * worked the enquiry address off their website and is trying to have their
   * mail copied to a mailbox they do not own — and from 3.1c, answered in their
   * name. It has to name who asked, and it has to be clear Eva has NOT agreed.
   */
  it("names who asked and makes clear Eva has not agreed to it", () => {
    const sentence = unexpectedRequestSentence("stranger@gmail.com");
    expect(sentence).toContain("stranger@gmail.com");
    expect(sentence).toMatch(/has not agreed/i);
    expect(sentence).toMatch(/turn it down/i);
  });

  /**
   * The address is the whole point of the question: "someone asked to forward
   * your mail" is unanswerable, and the customer can only recognise their own
   * mailbox if we show it to them.
   *
   * ⚠️ NARROWED AFTER ITS OWN RED RUN. This first banned the word "someone"
   * outright and failed on the sentence's honest second half — "if that was not
   * you or someone in your business". The rule was never "avoid a word", it was
   * "do not describe the ASKER generically", and the assertion now says that.
   */
  it("names the asker rather than describing them generically", () => {
    const sentence = unexpectedRequestSentence("a@b.com");
    expect(sentence.startsWith("a@b.com has asked")).toBe(true);
    expect(sentence).not.toMatch(/(someone|somebody) has asked/i);
  });
});
