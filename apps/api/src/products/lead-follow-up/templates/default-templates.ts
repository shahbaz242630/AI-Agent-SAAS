import type { ReplyChannel } from "@eva/types";

/**
 * The three wordings a customer starts with (slice 3.1c-1).
 *
 * Founder ruling 2026-08-21: *"Eva replies straight away from a small set of
 * templates (2–3) the customer edits."* These are that set. **Every one of them
 * is meant to be rewritten** — they exist so the screen is never empty and so a
 * customer who changes nothing still sends something sensible, not because we
 * know their trade better than they do.
 *
 * ⚠️ NO PLACEHOLDERS, AND THAT IS NOT AN OVERSIGHT. There is no substitution in
 * the send path — slice 3.1c-3 composes the reply, and until it exists nothing
 * turns `{{name}}` into a name. A default shipping with a token in it would
 * either send the token to a real enquirer or quietly commit us to building a
 * templating language before the reply works at all. When substitution lands,
 * these can gain a first name; today they read correctly without one.
 *
 * ⚠️ AND NO SIGN-OFF NAMING THE BUSINESS. The reply leaves the customer's OWN
 * mailbox (ruling: Eva sends from their address), so their display name and
 * signature are already on it. Writing "The team at ..." here would either be
 * blank or be wrong, and a business whose auto-reply gets its own name wrong
 * looks worse than one that does not sign off at all.
 */
export interface DefaultTemplate {
  readonly name: string;
  readonly body: string;
  /** Exactly one of these is true **per channel** — see `ensureDefaultTemplates`. */
  readonly isAutomatic: boolean;
}

/**
 * The wordings a customer starts with, **per channel** (slice 3.2b, ruling 63).
 *
 * 🔑 `Record<ReplyChannel, …>` IS THE GUARD, NOT DECORATION. Adding a channel to
 * `REPLY_CHANNELS` makes this object a type error until somebody writes wordings
 * for it. Without that, a new channel would ship with an empty list — and the
 * screen's own empty state reads *"somebody has deleted them all"*, so the
 * customer would be told they had done something they had not, on a channel
 * that silently could not answer anybody.
 *
 * ⚠️ AND THE WORDINGS MUST BE WRITTEN FOR THE MEDIUM, NOT COPIED. The email
 * default below says *"replying to this email is the quickest way to reach
 * us"*. Pasting that into WhatsApp is exactly the defect ruling 63 exists to
 * prevent, and it is the kind a test cannot catch — it is grammatical, sincere,
 * and wrong.
 */
export const DEFAULT_LEAD_REPLY_TEMPLATES: Record<ReplyChannel, readonly DefaultTemplate[]> = {
  email: [
    {
      /**
       * ⚠️ THE ONLY ONE EVA SENDS BY HERSELF (ruling 55). It is written to be
       * true no matter what the enquiry turns out to be: it promises a reply, not
       * a quote, a price, a visit or a date. An automatic message that commits
       * the business to something is a message the business has to climb back
       * down from, on the first impression.
       */
      name: "Standard reply",
      body: [
        "Thanks for getting in touch — your enquiry has come through and we have it.",
        "",
        "We will read it properly and come back to you shortly. If it is urgent, replying to this email is the quickest way to reach us.",
      ].join("\n"),
      isAutomatic: true,
    },
    {
      /**
       * Sent by hand. It says the same thing with the timescale made honest,
       * for the evening and weekend enquiries a trade gets most of.
       */
      name: "Out of hours",
      body: [
        "Thanks for getting in touch — your enquiry has come through outside our working hours.",
        "",
        "We will pick it up first thing and come back to you then. If it cannot wait, please call rather than reply, so it reaches somebody straight away.",
      ].join("\n"),
      isAutomatic: false,
    },
    {
      /**
       * Sent by hand, and the one a trade actually needs most: an enquiry that
       * says "how much for a new boiler" cannot be answered without more.
       */
      name: "Asking for more detail",
      body: [
        "Thanks for getting in touch. To give you an accurate answer rather than a guess, could you let us know a little more:",
        "",
        "- Where the work is, and roughly when you need it done",
        "- What is there at the moment, and what you would like instead",
        "- Anything already booked in or already quoted for",
        "",
        "Photographs help more than anything else — feel free to attach a few.",
      ].join("\n"),
      isAutomatic: false,
    },
  ],
  /**
   * WhatsApp (slice 3.4a, ruling 63). Written for a chat, not pasted from the
   * email set: shorter, no "reply to this email", and no talk of a signature —
   * the customer's WhatsApp business profile already carries their name on
   * every message, and a reply arrives in the same thread the person wrote in,
   * so "reply here" needs no saying.
   *
   * ⚠️ THE AUTOMATIC ONE MAKES THE SAME PROMISE AS EMAIL'S AND NO MORE: a
   * reply, not a quote, a price, a visit or a date. It goes out unread, in the
   * customer's name, to a stranger who may be standing in a flooded kitchen.
   */
  whatsapp: [
    {
      name: "Standard reply",
      body: [
        "Thanks for your message — we've got it.",
        "",
        "We'll read it properly and come back to you here shortly.",
      ].join("\n"),
      isAutomatic: true,
    },
    {
      name: "Out of hours",
      body: [
        "Thanks for your message — it's reached us outside our working hours.",
        "",
        "We'll pick it up first thing and reply here. If it can't wait, please call so it reaches somebody straight away.",
      ].join("\n"),
      isAutomatic: false,
    },
    {
      name: "Asking for more detail",
      body: [
        "Thanks for your message. To give you a proper answer rather than a guess, could you tell us:",
        "",
        "- Where the work is, and roughly when you need it",
        "- What's there now, and what you'd like instead",
        "",
        "A couple of photos here help more than anything.",
      ].join("\n"),
      isAutomatic: false,
    },
  ],
};
