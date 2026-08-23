/**
 * What a customer actually has to click in Gmail (Slice 3.1b, step 4).
 *
 * ⚠️ EVERY STEP AND EVERY WARNING BELOW WAS WALKED ON A REAL GMAIL ACCOUNT ON
 * 2026-08-22, NOT COPIED FROM GOOGLE'S HELP PAGES. That distinction earned its
 * keep twice in one sitting: Google's own documentation describes a screen that
 * did not match what the account actually showed, and the founder could not
 * find the button the instructions named. Both are covered here.
 *
 * ⚠️ THIS IS GOOGLE'S WORLD AND NOTHING ELSE'S (ruling 35). A Microsoft
 * customer must never be shown a Gmail step, so this file names Gmail freely
 * and nothing shared may import a word of it. The screen that renders it says
 * "In Gmail" above the first line.
 */

export interface ForwardingStep {
  /** What to do, in the imperative, naming what they will see. */
  instruction: string;
  /** The thing that goes wrong here, when something does. */
  warning?: string;
}

/**
 * ⚠️ THE THREE-CLICK PROMISE IS ABOUT THE CODE, NOT ABOUT THE NUMBER OF STEPS.
 * The decision document's claim is that the customer never hunts for a
 * confirmation code, because the confirmation email comes to us. Gmail still
 * makes them add the address and then switch forwarding on — two visits to the
 * same screen — and pretending otherwise would leave them stopping at step 4
 * with a verified address and no mail flowing. That is the state this project
 * shipped for itself on 2026-08-22 before anyone noticed.
 */
export const GMAIL_FORWARDING_STEPS: ForwardingStep[] = [
  {
    instruction:
      "In Gmail, open Settings (the gear, top right) → See all settings → Forwarding and POP/IMAP.",
  },
  {
    instruction: 'Click "Add a forwarding address".',
    warning:
      'If you see a text box next to "Forward a copy of incoming mail to" instead of that button, reload the page. Gmail sometimes draws this screen from a stale copy, and typing your address into that box fails with "Invalid forwarding address".',
  },
  {
    instruction: "Paste the address above, then click Next, then Proceed.",
    warning:
      "Google may ask you to confirm it is really you before it will send the confirmation. That is normal.",
  },
  {
    instruction:
      "Come back to this page. Eva reads Google's confirmation email and answers it for you — you never need the code.",
  },
  {
    instruction:
      'Back in Gmail, choose "Forward a copy of incoming mail to", pick your Eva address, and click Save Changes.',
    warning:
      "This last step is the one that actually starts the forwarding. Confirming the address only makes it available to choose — until you save this, nothing is forwarded.",
  },
];

/** How long the customer has, said the way a person would say it. */
export function armedWindowSentence(minutes: number): string {
  return `For the next ${minutes} minutes, Eva will confirm Google's request for you automatically. After that she will ask you first.`;
}

/**
 * What a request that nobody armed means, in the customer's terms.
 *
 * ⚠️ THIS SENTENCE IS THE SECURITY MODEL, AND IT MUST NOT BE SOFTENED INTO
 * "just checking". If it was not them, somebody has worked out the address on
 * their website and is trying to have their enquiries copied to a mailbox they
 * do not own — and from 3.1c, answered in their name. The screen has to make
 * that worth reading.
 */
export function unexpectedRequestSentence(sourceAddress: string): string {
  return `${sourceAddress} has asked Google to forward its mail to your enquiry address. Eva has not agreed to it. If that was not you or someone in your business, turn it down.`;
}
