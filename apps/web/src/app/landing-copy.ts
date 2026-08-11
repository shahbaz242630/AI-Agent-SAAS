/**
 * Every word on the landing page, and — where a word is not ours to write yet —
 * an explicit placeholder instead of a plausible sentence.
 *
 * ⚠️ THE COPY IS DATA SO A TEST CAN READ IT. This is the one screen a stranger
 * meets before they trust us with an invoice book, and the prototype arrived
 * carrying four things we cannot say: invented testimonials, a price, legal
 * documents that do not exist, and a data-residency claim that is not true.
 * Kept inline in the markup, each of those is a sentence somebody has to notice
 * on the day we launch. Kept here, `landing-copy.spec.ts` can insist that
 * anything undecided is still visibly marked as undecided.
 *
 * ⚠️ A PLACEHOLDER MUST LOOK LIKE ONE. That is the whole discipline: not "leave
 * it blank", but "leave it obviously unfinished". A realistic fake testimonial
 * is the kind of thing that survives to launch precisely because it reads
 * fine — the £29 nearly did.
 */

/** Marks a value the founder has not decided. Rendered in monospace beside the
 *  thing it qualifies, exactly as the design handoff draws it. */
export const PLACEHOLDER = "placeholder";

export const HERO = {
  eyebrow: "AI Business Communications Platform",
  headline: "The practical AI employee for UK small businesses.",
  lead: "Eva chases your unpaid invoices, follows up your leads and answers your calls — module by module, sending from your own mailbox so replies come straight back to you.",
  primaryCta: "Get started free",
  secondaryCta: "See how it works",
  /**
   * ⚠️ "NO CARD NEEDED" IS NOT HERE, AND MUST NOT COME BACK. The design puts it
   * in this line. It was cut from the auth pages on 2026-08-10 for the reason
   * it is cut here: it is a promise about a billing system that does not exist
   * yet, made to somebody deciding whether we are honest. Restore it when
   * there is a price and it is true — not before.
   */
  reassurance: "Connect your Outlook or Microsoft 365 mailbox. Gmail is not supported yet.",
} as const;

/**
 * The hero's product illustration.
 *
 * ⚠️ THESE FIGURES ARE INVENTED, AND THE SCREEN SAYS SO. On the auth pages the
 * identical panel was deleted outright, because numbers beside a sign-in form
 * read as YOUR numbers to the person about to sign in. A landing page is
 * different — a labelled example of the product is the normal way to show
 * software, and showing nothing would be its own kind of evasion. The label is
 * what makes it honest, so it is part of the data rather than decoration a
 * redesign could drop.
 */
export const HERO_EXAMPLE = {
  label: "Example",
  totalCaption: "Outstanding · GBP",
  total: "£18,420.50",
  totalDetail: "23 invoices · Eva is chasing 12",
  sentChip: "Sent",
  sentLine: "Second reminder → Marsh & Doyle Ltd · INV-2041",
  paidLine: "Paid in full — INV-2033 settled. Eva stops chasing automatically.",
} as const;

export const MODULES = [
  {
    name: "Invoice Chasing",
    status: "Live",
    live: true,
    body: "Polite, persistent reminders for what’s left on every invoice — never the total, never across currencies. You set the schedule; Eva does the awkward part.",
  },
  {
    name: "Lead Follow-up",
    status: "Soon",
    live: false,
    body: "Every enquiry answered and followed up while it’s still warm — so quotes stop dying in the inbox.",
  },
  {
    name: "AI Reception",
    status: "Soon",
    live: false,
    body: "Calls answered, messages taken, appointments booked — even when you’re up a ladder.",
  },
] as const;

export const STEPS = [
  {
    title: "Connect your mailbox",
    body: "Sign in at Microsoft — Eva never sees your password. She sends from your address, so replies land back with you.",
  },
  {
    title: "Add your invoices",
    body: "Type them in or upload a spreadsheet. Eva keeps the book per currency and tracks what’s left on each one.",
  },
  {
    title: "Eva chases, you watch",
    body: "Reminders go out on the schedule you set. Every send, wait and failure is on one screen — nothing happens silently.",
  },
] as const;

export const FEATURES = [
  {
    title: "Chases what’s left",
    body: "Part-payments respected — Eva asks for the balance, never the original total.",
  },
  {
    title: "Honest per-currency books",
    body: "GBP and AED never added into one made-up number. Each currency stands alone.",
  },
  {
    title: "Your schedule, your tone",
    body: "You decide when the first nudge goes and how firm the final notice sounds.",
  },
  {
    title: "Nothing happens silently",
    body: "Sent, waiting, didn’t send — every reminder is on the record, with the reason.",
  },
] as const;

/**
 * ⚠️ NOT QUOTES. NOBODY HAS SAID THESE. Eva has no customers, so there is
 * nothing to quote, and a landing page that invents praise is lying on the one
 * screen where it is asking to be believed. The design draws two cards with
 * striped avatars and monospace captions for exactly this reason: the shape of
 * the section, with the shape of the truth. Replace only with something a real
 * person actually said, in writing, knowingly.
 */
export const TESTIMONIALS = [
  {
    quote:
      "Placeholder — a line from a real customer about the invoice they’d given up on, until Eva got it paid.",
    name: "Customer name",
    caption: `${PLACEHOLDER} · trade + town`,
  },
  {
    quote:
      "Placeholder — the sole trader who hated writing chasing emails, on what it feels like to stop.",
    name: "Customer name",
    caption: `${PLACEHOLDER} · trade + town`,
  },
] as const;

/**
 * ⚠️ THE PRICE IS NOT DECIDED AND THE PAGE SAYS SO. The design shows £29/month
 * marked placeholder; the marking is the important half. A number here is a
 * promise, and this one has never been costed against what a send actually
 * costs us.
 */
export const PRICING = {
  headline: "Simple pricing, one organisation.",
  body: "Invoice Chasing included. Add modules as they launch.",
  amount: "£29",
  period: "/month",
  marker: `${PLACEHOLDER} pricing`,
  cta: "Get started",
} as const;

/**
 * ⚠️ "DATA HOSTED IN LONDON, UK" — WHAT THE DESIGN SAYS, AND WHAT WE MAY NOT
 * SAY. The database is in London; the api, the web app and the worker all run
 * in the USA (`us-west2` and `us-east-1`), so invoice contents, client names
 * and reminder bodies are all PROCESSED outside the UK. Under UK GDPR those are
 * international transfers, and it is exactly the fact a cautious buyer chooses
 * a supplier on. Founder ruling, 2026-08-10: say the literally true thing.
 */
export const TRUST = [
  "Eva’s database runs in London",
  "Eva never sees your password",
  "Sends only from your own mailbox",
  "Every send logged",
] as const;

export const FAQ = [
  {
    question: "Where does Eva send from?",
    answer:
      "Your own mailbox — Outlook, Hotmail or Microsoft 365 today. Replies come straight back to you, not to a robot.",
  },
  {
    question: "Does Eva ever see my password?",
    answer:
      "No. You sign in at Microsoft; Eva only gets permission to send, which you can withdraw any time.",
  },
  {
    question: "What exactly does Eva chase?",
    answer:
      "What’s left on each invoice, in its own currency. Part-payments are respected and nothing is ever totalled across currencies.",
  },
  {
    question: "When does she chase?",
    answer:
      "On the schedule you set — first nudge, second reminder, final notice. Pause any invoice or client whenever you like.",
  },
  {
    question: "I work for myself — is Eva for me?",
    answer:
      "Yes. Register under your own name — Eva is built for sole traders and freelancers as much as for limited companies.",
  },
  {
    /**
     * ⚠️ THE DESIGN ANSWERS "In the UK". That is the claim the trust strip was
     * corrected for, and it is no more true in a FAQ than in a strip. The
     * database's location is stated; the processing is not hidden.
     */
    question: "Where is my data kept?",
    answer:
      "Eva’s database runs in London. Some processing happens on servers outside the UK, and we will say exactly where before we ask anyone to sign a contract.",
  },
] as const;

export const FOOTER = {
  tagline: "The practical AI employee for UK small businesses.",
  columns: [
    { heading: "Product", items: ["Invoice Chasing", "Lead Follow-up", "AI Reception"] },
    { heading: "Company", items: ["About us", "Documents", "Contact"] },
    /**
     * ⚠️ RENDERED AS TEXT, NOT LINKS, AND THAT IS DELIBERATE. We have neither
     * document. A footer link to a Privacy page that 404s is worse than no link
     * at all on a page collecting sign-ups — and under UK GDPR the page needs a
     * real privacy notice before it is public, which is one of the four
     * decisions still blocked on company registration.
     */
    { heading: "Legal", items: ["Privacy", "Terms"] },
  ],
  legalNote: `${PLACEHOLDER} — no page behind these yet`,
  copyright: "© 2026 Eva. Made in the UK.",
} as const;
