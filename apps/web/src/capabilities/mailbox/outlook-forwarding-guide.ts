import type { ForwardingStep } from "./forwarding-guide";

/**
 * What a customer has to click in Outlook to send Eva their enquiries
 * (the Mailbox tab, 2026-09-05).
 *
 * ⚠️ WRITTEN FROM MICROSOFT'S OWN HELP, NOT YET WALKED ON A REAL ACCOUNT.
 * The Gmail guide beside this one was walked on a real mailbox and caught two
 * things Google's documentation got wrong; this one has not had that test.
 * The founder's own Outlook.com account is the walk — until it has been
 * done, treat a customer report about these steps as probably right.
 *
 * ⚠️ THIS IS MICROSOFT'S WORLD AND NOTHING ELSE'S (ruling 35). A Gmail
 * customer must never be shown an Outlook step, so this file names Outlook
 * freely and nothing shared may import a word of it. The screen that renders
 * it says "In Outlook" above the first line.
 *
 * ⚠️ THERE IS NOTHING FOR EVA TO CONFIRM. Google emails a confirmation that
 * Eva answers; Microsoft asks the customer nothing and starts forwarding on
 * save. That is why this guide has no "I'm setting this up now" button and
 * one step fewer.
 */
export const OUTLOOK_FORWARDING_STEPS: ForwardingStep[] = [
  {
    instruction: "In Outlook on the web, open Settings (the gear, top right) → Mail → Forwarding.",
  },
  {
    instruction: 'Turn on "Enable forwarding" and paste the address above.',
    warning:
      "Outlook.com may ask you to switch on two-step verification before it lets you forward. That is Microsoft's rule for forwarding, not Eva's.",
  },
  {
    instruction: 'Tick "Keep a copy of forwarded messages", then Save.',
    warning: "Without that tick your enquiries leave your own inbox and only Eva has them.",
  },
  {
    instruction:
      "That is all — Microsoft starts forwarding the moment you save, with nothing to confirm.",
    warning:
      'On a Microsoft 365 work account, forwarded mail can bounce with "your organisation does not allow external forwarding". If it does, your Microsoft 365 administrator has to allow it — Eva cannot.',
  },
];

/** Microsoft's own page for the same steps, for a customer who wants it from them. */
export const OUTLOOK_FORWARDING_HELP_URL =
  "https://support.microsoft.com/en-us/outlook/mail/turn-automatic-forwarding-on-or-off-in-outlook";
