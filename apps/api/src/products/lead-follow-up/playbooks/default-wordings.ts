import type { LeadPlaybookBuiltKey, ReplyChannel } from "@eva/types";

/**
 * The words each card starts with, per channel (slice 3.1c-1's defaults,
 * re-homed under the cards in 3.5a).
 *
 * Founder ruling 2026-08-21: *"Eva replies straight away from a small set of
 * templates (2–3) the customer edits."* **Every one of them is meant to be
 * rewritten** — they exist so a box is never empty and so a customer who
 * changes nothing still sends something sensible, not because we know their
 * trade better than they do.
 *
 * ⚠️ TWO CARDS, NOT THREE. "Asking for more detail" shipped in the seed from
 * 3.1c-1 and was read by nothing; it is qualification, which needs the AI
 * seam (3.7), and a wording on a screen that promises what nothing does is
 * the send-by-hand mistake again. It leaves the seed here (ruling 93).
 *
 * ⚠️ NO PLACEHOLDERS, AND THAT IS NOT AN OVERSIGHT. There is no substitution
 * in the send path, so a default with `{{name}}` in it would send the token to
 * a real enquirer.
 *
 * ⚠️ AND NO SIGN-OFF NAMING THE BUSINESS. The reply leaves the customer's OWN
 * mailbox or number, so their name is already on it.
 *
 * 🔑 `Record<LeadPlaybookBuiltKey, Record<ReplyChannel, string>>` IS THE GUARD.
 * A new built card, or a new channel, is a type error here until somebody
 * writes its words — written for the medium, not pasted (ruling 63): the email
 * default says "replying to this email is the quickest way to reach us", which
 * is nonsense over WhatsApp.
 */
export const DEFAULT_LEAD_PLAYBOOK_WORDINGS: Record<
  LeadPlaybookBuiltKey,
  Record<ReplyChannel, string>
> = {
  /**
   * ⚠️ THE ONE EVA SENDS BY HERSELF THE MOMENT AN ENQUIRY ARRIVES (ruling 55).
   * Written to be true no matter what the enquiry turns out to be: it
   * promises a reply, not a quote, a price, a visit or a date. An automatic
   * message that commits the business to something is a message the business
   * has to climb back down from, on the first impression.
   */
  instant_reply: {
    email: [
      "Thanks for getting in touch — your enquiry has come through and we have it.",
      "",
      "We will read it properly and come back to you shortly. If it is urgent, replying to this email is the quickest way to reach us.",
    ].join("\n"),
    whatsapp: [
      "Thanks for your message — we've got it.",
      "",
      "We'll read it properly and come back to you here shortly.",
    ].join("\n"),
  },
  /**
   * The same promise with the timescale made honest, for the evening and
   * weekend enquiries a trade gets most of. Sent INSTEAD of the instant reply
   * when the enquiry arrives outside opening hours and the card is on.
   */
  after_hours: {
    email: [
      "Thanks for getting in touch — your enquiry has come through outside our working hours.",
      "",
      "We will pick it up first thing and come back to you then. If it cannot wait, please call rather than reply, so it reaches somebody straight away.",
    ].join("\n"),
    whatsapp: [
      "Thanks for your message — it's reached us outside our working hours.",
      "",
      "We'll pick it up first thing and reply here. If it can't wait, please call so it reaches somebody straight away.",
    ].join("\n"),
  },
};
