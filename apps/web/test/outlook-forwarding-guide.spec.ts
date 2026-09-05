import { describe, expect, it } from "vitest";
import { GMAIL_FORWARDING_STEPS } from "../src/capabilities/mailbox/forwarding-guide";
import { OUTLOOK_FORWARDING_STEPS } from "../src/capabilities/mailbox/outlook-forwarding-guide";

/**
 * The words a customer follows to point Outlook at Eva (the Mailbox tab,
 * 2026-09-05).
 *
 * ⚠️ COPY THAT NO TEST PINS IS COPY THAT CAN SILENTLY DEGRADE — the same rule
 * `forwarding-guide.spec.ts` states for Gmail. These are instructions for
 * somebody standing in a screen we do not control, so the sentences that keep
 * them out of a known hole are asserted here.
 */

const outlookText = OUTLOOK_FORWARDING_STEPS.map(
  (step) => `${step.instruction} ${step.warning ?? ""}`,
).join(" ");
const gmailText = GMAIL_FORWARDING_STEPS.map(
  (step) => `${step.instruction} ${step.warning ?? ""}`,
).join(" ");

describe("The Outlook forwarding guide", () => {
  /**
   * ⚠️ MICROSOFT 365 BLOCKS EXTERNAL FORWARDING BY DEFAULT (since 2021), and
   * the customer finds out from a bounce, not from us. The guide has to say so
   * where it bites, name who can lift it, and not pretend Eva can.
   */
  it("warns that a work account's administrator may have to allow it, and that Eva cannot", () => {
    const step = OUTLOOK_FORWARDING_STEPS.find((candidate) =>
      /administrator/i.test(candidate.warning ?? ""),
    );
    expect(step?.warning).toMatch(/does not allow external forwarding/i);
    expect(step?.warning).toMatch(/Eva cannot/);
  });

  /**
   * Without "keep a copy", forwarding MOVES the mail: the customer's own inbox
   * goes quiet and only Eva has their enquiries. That is a support ticket with
   * our name on it, so the step says what the tick is for.
   */
  it("tells them to keep a copy, and why", () => {
    const step = OUTLOOK_FORWARDING_STEPS.find((candidate) =>
      /keep a copy/i.test(candidate.instruction),
    );
    expect(step?.warning).toMatch(/only Eva has them/i);
  });

  /** The same rule Gmail's guide holds: the last step is the one that starts the mail. */
  it("ends on the step that actually starts forwarding", () => {
    const last = OUTLOOK_FORWARDING_STEPS.at(-1);
    expect(last?.instruction).toMatch(/starts forwarding/i);
  });

  /**
   * ⚠️ PROVIDERS NEVER CROSS PATHS (ruling 35, founder 2026-08-22). A Gmail
   * customer told to look for "Enable forwarding" and an Outlook customer told
   * to reload a stale Gmail pane are both stuck somewhere we cannot see. Each
   * guide names its own provider freely and the other one never.
   */
  it("never mentions Gmail or Google, and Gmail's guide never mentions Outlook or Microsoft", () => {
    expect(outlookText).not.toMatch(/gmail|google/i);
    expect(gmailText).not.toMatch(/outlook|microsoft/i);
  });

  it("never promises a confirmation code or a confirmation email, because Microsoft sends neither", () => {
    expect(outlookText).not.toMatch(/confirmation (code|email)/i);
  });
});
