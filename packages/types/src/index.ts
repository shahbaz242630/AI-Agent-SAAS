/**
 * Shared cross-app contracts (BRD Section 8).
 * Only types that genuinely cross module/app boundaries belong here.
 */

/**
 * Money arithmetic is shared because it MUST NOT be duplicated: the api parses
 * what a human typed and the web app formats what came back, and two copies of
 * a minor-unit table drift into two different answers for the same invoice.
 */
export * from "./money.js";

/** Liveness payload returned by every service's GET /health endpoint. */
export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
}

/** Readiness payload returned by GET /health/ready — dependency connectivity. */
export interface ReadinessResponse {
  status: "ok" | "error";
  service: string;
  version: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  checks: {
    database: "up" | "down";
  };
}

/** Organisation roles (BRD Section 7). Enforced in the backend on every request. */
export const ORGANISATION_ROLES = [
  "owner",
  "administrator",
  "finance",
  "sales",
  "reception",
  "read_only",
] as const;

export type OrganisationRole = (typeof ORGANISATION_ROLES)[number];

/**
 * Permission keys checked by API guards (Slice 1.1; BRD 7 amendment). Guards
 * never name roles — they ask whether the caller's role holds the permission
 * in this organisation (org mapping → DEFAULT_ROLE_PERMISSIONS fallback).
 */
export const PERMISSION_KEYS = [
  "customers:read",
  "customers:write",
  "contacts:read",
  "contacts:write",
  "invoices:read",
  "invoices:write",
  "imports:read",
  "imports:write",
  "permissions:read",
  "permissions:manage",
  "reminders:read",
  "reminders:write",
  "mailbox:read",
  "mailbox:manage",
  /** Slice 1.6a. Both are `core`: an organisation with no modules must still be
   *  able to see what exists and buy one, or it can never become a customer. */
  "modules:read",
  "modules:manage",
  /**
   * Slice 3.1a. The lead product finally owns permissions of its own — until
   * now it granted nothing at all, so buying it gave a customer no new access
   * to anything.
   */
  "leads:read",
  "leads:write",
  /**
   * Slice 3.1a follow-up. Seeing the do-not-contact record, and recording that
   * an entry on it was made in error.
   *
   * ⚠️ DELIBERATELY NOT HELD BY THE ROLES THAT CAN CREATE ONE. Sales and
   * reception carry `leads:write`, which is what presses the do-not-contact
   * button; undoing a mis-click is a DIFFERENT act and belongs to whoever
   * answers for the organisation's compliance. If the person who made the
   * mistake could also erase it, the record would only be as good as their
   * embarrassment. Owner and administrator, and nobody else by default.
   *
   * ⚠️ ONE KEY FOR READING AND CORRECTING, ON PURPOSE. The list names people
   * who asked a business to leave them alone. There is no audience that should
   * browse it but not be trusted to fix it.
   */
  "suppression:manage",
  /**
   * Slice 3.1c-1. The wordings Eva replies to enquiries with.
   *
   * ⚠️ OWNER ONLY — founder ruling 2026-09-01, *"owner only for templates"*.
   * Not `administrator`, which is why it is excluded from that role's filter
   * below rather than inherited like every other new key.
   *
   * ⚠️ AND IT IS DELIBERATELY NOT `leads:write`. Filing a lead and recording a
   * do-not-contact are day-to-day work that sales and reception do; changing
   * the message that goes out UNREAD, automatically, to every stranger who
   * enquires, in the business's own name, is not. The invoice side already
   * draws this line — configuring the chaser is `reminders:write`, which sales
   * does not hold — and this is the same line on the lead side.
   *
   * ⚠️ READING IS STILL `leads:read`. Sales and reception must be able to SEE
   * the wordings, or the "send one by hand from an enquiry" half of the product
   * (3.1c-4) is closed to the people whose job it is.
   */
  "lead_templates:manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * BRD 7 default role→permission matrix. Applies to every organisation that
 * has no custom rows in organisation_role_permissions. High-risk actions
 * (legal threats, fees, discounts, marking paid, commitments) are NEVER
 * permission-keyed — they stay human-confirmed regardless of configuration.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<OrganisationRole, readonly PermissionKey[]> = {
  owner: PERMISSION_KEYS,
  /**
   * Everything EXCEPT `modules:manage` (slice 1.6a). Turning a product on is
   * the one action here that commits the business to money, and that belongs
   * to whoever owns the account rather than to anyone they delegate
   * administration to. Written as a filter rather than a hand-maintained list
   * so an administrator keeps inheriting every future permission by default,
   * which is the existing intent.
   */
  /**
   * ⚠️ TWO EXCLUSIONS NOW, AND THE SECOND ARRIVED 2026-09-01. `modules:manage`
   * commits the business to money; `lead_templates:manage` decides what a
   * stranger reads in the business's name without anybody checking first.
   * Founder ruling: *"owner only for templates"*.
   *
   * Still written as a filter so an administrator keeps inheriting every FUTURE
   * permission by default — the existing intent — with the exceptions named.
   */
  administrator: PERMISSION_KEYS.filter(
    (key) => key !== "modules:manage" && key !== "lead_templates:manage",
  ),
  finance: [
    "customers:read",
    "customers:write",
    "contacts:read",
    "contacts:write",
    "invoices:read",
    "invoices:write",
    "imports:read",
    "imports:write",
    // BRD §6: finance configures reminder sequences; everyone reads them.
    "reminders:read",
    "reminders:write",
    // BRD §6 adjacency: finance lives with mailbox connection health day-to-day.
    "mailbox:read",
    // Which products the organisation holds is not billing detail, and finance
    // needs it to make sense of a 402 rather than reading it as a fault.
    "modules:read",
  ],
  /**
   * ⚠️ SALES AND RECEPTION CAN WRITE LEADS, AND THEY ARE THE ONLY TWO (3.1a).
   *
   * Enquiries are sales' actual job, and reception is who fields them when
   * sales cannot. Both roles are otherwise read-only across this product, which
   * is why these are their first write permissions and why they are worth
   * stating rather than inheriting.
   *
   * ⚠️ WHAT `leads:write` MEANS NARROWED ON 2026-08-21. It used to include
   * logging a missed call by hand; that form is gone, because Lead Follow-up by
   * Email is one mailbox in and a reply out. What it now carries is recording a
   * do-not-contact — and NOT undoing one, which is `suppression:manage` and
   * belongs to a different set of people on purpose.
   *
   * Finance is deliberately left out: an unanswered enquiry is not a
   * receivable, and a permission granted "just in case" is one nobody can
   * later argue about removing.
   */
  sales: [
    "customers:read",
    "contacts:read",
    "invoices:read",
    "imports:read",
    "reminders:read",
    "leads:read",
    "leads:write",
  ],
  reception: [
    "customers:read",
    "contacts:read",
    "invoices:read",
    "imports:read",
    "reminders:read",
    "leads:read",
    "leads:write",
  ],
  read_only: [
    "customers:read",
    "contacts:read",
    "invoices:read",
    "imports:read",
    "reminders:read",
    "leads:read",
  ],
};

// --- Slice 1.6a: module entitlements ---

/**
 * The products an organisation can hold (BRD entitlement model).
 *
 * ⚠️ FIVE, NOT FOUR, SINCE 2026-08-19. Founder ruling: chasing a new enquiry by
 * EMAIL and chasing one by PHONE are two products a customer buys separately,
 * not one product with two settings. They need different machinery (a mailbox
 * versus a voice stack), they will not cost the same, and a plumber who wants
 * his enquiries emailed back should not be sold a telephony bill.
 *
 * `lead_follow_up_agent` was the single placeholder key and is retired —
 * migration 0025 maps any surviving row onto the email variant. Nothing was
 * ever built behind it.
 */
export const MODULE_KEYS = [
  "email_credit_controller",
  "voice_credit_controller",
  "lead_follow_up",
  "lead_follow_up_voice",
  "ai_receptionist",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * Is this string one of our five products?
 *
 * ⚠️ WRITTEN FOR THE OAUTH STATE (slice 3.1c-0), WHERE THE ALTERNATIVE IS A
 * SILENT WRONG ANSWER. A mailbox now belongs to one product, and the product
 * travels on the signed state through the round trip to Google or Microsoft.
 * Narrowing it there with this guard is what lets the callback REFUSE an
 * unreadable product instead of falling back to Invoice Chasing and filing a
 * customer's Lead Follow-up mailbox against another product's seat.
 */
export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/**
 * Which products carry each permission.
 *
 * The `Record<PermissionKey, …>` type IS the exhaustiveness guarantee: adding a
 * permission key without assigning it a module fails the build. There is no
 * rule for anyone to remember and nothing to rot — which matters, because the
 * failure mode of a forgotten mapping is a permission silently escaping
 * enforcement forever.
 *
 * **`core` is not a loophole, it is a requirement.** An organisation with zero
 * modules must still reach organisation, member and billing management, or it
 * can never buy anything — the lockout trap. Customers and contacts are shared
 * by all four products, so they are core too.
 *
 * ⚠️ A PERMISSION IS SATISFIED BY **ANY ONE** OF THE PRODUCTS THAT NEED IT.
 *
 * Always a list, never a bare key, and the shape is deliberate: enforcement
 * then handles exactly two cases — `core`, or "hold at least one of these" —
 * instead of three. A non-empty tuple type is what stops `[]` being written,
 * which would silently mean "nobody may ever do this".
 *
 * The single-product entries are lists of one. That is not noise: it is what
 * makes adding a second owner a one-word edit rather than a shape change, and
 * a shape change is where somebody would have quietly kept the old branch.
 */
export const PERMISSION_MODULES: Record<
  PermissionKey,
  "core" | readonly [ModuleKey, ...ModuleKey[]]
> = {
  "customers:read": "core",
  "customers:write": "core",
  "contacts:read": "core",
  "contacts:write": "core",
  "permissions:read": "core",
  "permissions:manage": "core",
  "modules:read": "core",
  "modules:manage": "core",
  "invoices:read": ["email_credit_controller"],
  "invoices:write": ["email_credit_controller"],
  "imports:read": ["email_credit_controller"],
  "imports:write": ["email_credit_controller"],
  "reminders:read": ["email_credit_controller"],
  "reminders:write": ["email_credit_controller"],
  /**
   * ⚠️ THE MAILBOX IS SHARED MACHINERY, NOT INVOICE FOLLOW-UP'S PROPERTY.
   *
   * It belonged to `email_credit_controller` alone until 2026-08-19, which
   * meant a customer who bought ONLY the lead agent could not connect a
   * mailbox — the one thing that product needs to do anything at all. The
   * capability is `mailbox` (see `MODULE_CAPABILITIES`); these are the products
   * that carry it.
   */
  "mailbox:read": ["email_credit_controller", "lead_follow_up"],
  "mailbox:manage": ["email_credit_controller", "lead_follow_up"],
  /**
   * ⚠️ EMAIL ONLY, NOT BOTH LEAD PRODUCTS. Founder ruling 14 makes lead
   * follow-up by email and by call two separate purchases with different
   * machinery. A customer who eventually buys only the voice one will need its
   * own keys, pointed at its own screens — listing both here now would grant
   * access to a lead book on the strength of buying a phone product that
   * cannot yet write to it.
   */
  "leads:read": ["lead_follow_up"],
  "leads:write": ["lead_follow_up"],
  /** Same product as the lead keys; a different set of PEOPLE (owner alone). */
  "lead_templates:manage": ["lead_follow_up"],
  /**
   * ⚠️ `core`, AND NOT BECAUSE IT IS CONVENIENT. Do-not-contact is
   * organisation-wide and crosses every product by BRD design — an entry
   * recorded on an enquiry stops invoice chasers to the same address. Tying it
   * to the lead product would mean a business that later switches lead
   * follow-up off loses the ability to SEE, let alone fix, a list that is still
   * silencing its invoice chasers. A compliance record you cannot reach is
   * worse than one you never made.
   */
  "suppression:manage": "core",
};

/**
 * Which products a customer must ALREADY OWN before buying this one.
 *
 * ⚠️ **DELIBERATELY EMPTY, AND IT MUST STAY THAT WAY UNLESS A REAL ONE APPEARS.**
 * Founder ruling 2026-08-19: the four products are separate purchases, switched
 * on and off independently. Buying invoice follow-up must never switch on lead
 * follow-up, voice or the receptionist. What a product needs in order to WORK is
 * machinery — see `MODULE_CAPABILITIES`, which is where the entries that used to
 * be here actually belonged.
 *
 * The constant survives its own emptying on purpose. It is the one place a
 * genuine product-to-product prerequisite would go, and deleting it would mean
 * the next person invents a second mechanism somewhere else. Its test asserts
 * the RULE (empty means nothing is refused, a listed prerequisite is enforced),
 * not today's contents, so it cannot rot while unused.
 *
 * Validated when ENABLING, never re-derived per request — a stored invalid
 * combination is a bug to prevent at the write, not to pay for on every check.
 */
export const MODULE_DEPENDENCIES: Record<ModuleKey, readonly ModuleKey[]> = {
  email_credit_controller: [],
  voice_credit_controller: [],
  lead_follow_up: [],
  lead_follow_up_voice: [],
  ai_receptionist: [],
};

/**
 * Machinery a product needs in order to work. **Never sold, never on a switch,
 * never chosen by a customer** — it switches itself on for whichever product
 * needs it and is billed inside that product's price. The BRD's phrase is
 * "voice platform included".
 */
export const CAPABILITIES = ["mailbox", "voice", "invoice_ledger"] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * ⚠️ THIS MAP IS WHAT `MODULE_DEPENDENCIES` WAS WRONGLY DOING.
 *
 * The BRD says the lead agent needs "the voice **platform**", and that voice
 * credit control needs the "Email Credit Controller **data model** present".
 * Both are machinery. The code read them as products the customer must buy,
 * and wrote `lead_follow_up_agent: ["voice_credit_controller"]`.
 *
 * The result was not a style problem. `assertDependenciesMet` refuses to enable
 * a product unless every dependency is already enabled, so **three of the six
 * packages in the BRD's own price list could not be sold**: "Lead Assistant"
 * (lead follow-up only), "AI Receptionist" (receptionist only) and "Sales Desk"
 * (the two together) were all refused, while §4.3 says in as many words that
 * the lead agent "does not require the Voice Credit Controller module".
 *
 * The price list and the rule lived in different files with nothing between
 * them — the money bug, the lying upload preview and the three phantom
 * products all over again.
 */
export const MODULE_CAPABILITIES: Record<ModuleKey, readonly Capability[]> = {
  email_credit_controller: ["mailbox", "invoice_ledger"],
  /**
   * ⚠️ THIS PAIR IS WHY THE SPLIT IS REAL, NOT COSMETIC. The two lead products
   * need entirely different machinery — one a connected mailbox, the other a
   * voice stack we have not built. As one product it would have been "ready"
   * and "not ready" at the same time, and no honest answer existed for the
   * readiness line on its card.
   */
  lead_follow_up: ["mailbox"],
  lead_follow_up_voice: ["voice"],
  /**
   * ⚠️ `mailbox` IS HERE BECAUSE OF RULING 42, AND SINCE SLICE 3.1c-0 IT ALSO
   * SWITCHES ON SEAT COUNTING. Voice Credit Control sends ONE email before it
   * ever calls, so it needs a mailbox like any sending product — and
   * `countSeatsUsed` now derives "does this product have seats" from this very
   * list. Without the entry the product would have sent email from a mailbox
   * nobody was counting or charging for.
   */
  voice_credit_controller: ["voice", "mailbox", "invoice_ledger"],
  ai_receptionist: ["voice"],
};

/**
 * What each product is CALLED, what it does, and whether it exists yet.
 *
 * ⚠️ THE NAMES LIVED IN THREE PLACES AND DISAGREED IN TWO OF THEM (found by
 * walking, 2026-08-18). The sidebar said "Lead Follow-up" and "AI Reception",
 * the settings screen said "Lead Follow-Up" and "AI Receptionist", and the 402
 * message had its own third copy. A customer reading two of our screens saw
 * two different products.
 *
 * ⚠️ `live` IS THE ONE THAT MATTERS, AND IT IS NOT COSMETIC. Three of these
 * four products are not built. `PERMISSION_MODULE` grants them nothing, so
 * turning one on wrote an entitlement row, printed "On", and changed nothing
 * whatsoever — the screen reporting an outcome that had not happened, which is
 * the same failure as the money bug and the lying upload preview. The flag is
 * read by BOTH the screen (which offers no button) and the API (which refuses
 * the write), because hiding a control is not enforcement.
 *
 * Flip a `live` to `true` in this one place on the day the product ships.
 */
export interface ModuleDescriptor {
  /** The product's name, as a customer reads it. Never the database key. */
  readonly name: string;
  /**
   * The product's own path segment, under `/app`.
   *
   * ⚠️ IT LIVES HERE BECAUSE THIS PRODUCT ALREADY HAD THREE NAMES. The key is
   * `email_credit_controller`, the code folder is `invoice-follow-up`, and a
   * customer reads "Invoice Chasing". A URL invented at the call site would be
   * a fourth, and four names for one product is precisely how the sidebar came
   * to disagree with the settings screen. Build every product link with
   * `moduleHref`; never write `/app/invoice-chasing` by hand.
   */
  readonly slug: string;
  /** One honest line about what it does. */
  readonly blurb: string;
  /** Whether the product is BUILT. `false` means it cannot be turned on. */
  readonly live: boolean;
}

export const MODULE_CATALOGUE: Record<ModuleKey, ModuleDescriptor> = {
  email_credit_controller: {
    name: "Invoice Chasing",
    slug: "invoice-chasing",
    blurb: "Chases your unpaid invoices by email, from your own mailbox.",
    live: true,
  },
  voice_credit_controller: {
    name: "Voice Credit Control",
    slug: "voice-credit-control",
    /**
     * ⚠️ IT SAID "by phone when email has not worked" AND THAT CONTRADICTED
     * RULING 42, on the screen that SELLS it. The founder's model is ONE email
     * first and then calls for the remaining reminders — not calling as a
     * fallback after email fails. A blurb describing a different product than
     * the one we would build is the worst place for this to be wrong.
     */
    blurb: "Chases overdue invoices with one email, then follows up by phone.",
    live: false,
  },
  /**
   * ⚠️ ONE ENTRY BECAME TWO (founder ruling 2026-08-19). It read "Lead
   * Follow-up" with the blurb "Calls back new enquiries before they go cold" —
   * which was false twice over: the first version will not call anyone, and
   * "Lead Follow-up" named two products a customer buys separately. A blurb
   * promising a phone call on the screen that SELLS it is the money-bug family:
   * the screen claiming an outcome that does not happen.
   *
   * ⚠️ AND THE NAME WENT BACK (founder ruling 62, 2026-09-02) — WITHOUT
   * UNDOING THAT. "by Email" was the right name while email was the only way in;
   * the product now grows WhatsApp, Messenger and Instagram as ONE feature, so
   * the line between this product and `lead_follow_up_voice` is no longer
   * "email versus phone" but "typed channels versus a phone call". Ruling 14
   * still holds: a call is a separate purchase.
   */
  lead_follow_up: {
    name: "Lead Follow-up",
    slug: "lead-follow-up",
    /**
     * 🚨 THE BLURB STILL SAYS MAILBOX, AND THAT IS DELIBERATE. Renaming the
     * product is structural — a key, a folder, a URL — and costs nothing to do
     * before the channels exist. Changing this sentence is a PROMISE, on the
     * screen that sells it, and today the only channel Eva can answer on is
     * email. This is the exact family of defect this file already carries two
     * warnings about: the blurb describing a product we have not built.
     *
     * **Widen it in the slice that makes it true**, not in the slice that
     * renames the folder.
     */
    blurb: "Answers new enquiries from your mailbox, usually within minutes.",
    live: false,
  },
  lead_follow_up_voice: {
    name: "Lead Follow-up by Call",
    slug: "lead-follow-up-call",
    blurb: "Calls new enquiries back before they go cold.",
    live: false,
  },
  ai_receptionist: {
    name: "AI Receptionist",
    slug: "ai-receptionist",
    blurb: "Answers the phone when you cannot get to it.",
    live: false,
  },
};

/** A product's name, for a sentence a person will read. */
export function moduleName(moduleKey: ModuleKey): string {
  return MODULE_CATALOGUE[moduleKey].name;
}

/**
 * How long Eva will answer Google's forwarding confirmation for a customer
 * without asking them first (Slice 3.1b, step 4).
 *
 * ⚠️ IT LIVES IN THE SHARED KERNEL FOR ONE REASON: BOTH TIERS STATE IT, AND A
 * DRIFT WOULD BE SILENT. The API enforces the window; the guided screen puts
 * the number in a sentence a customer reads before they walk off to Gmail.
 * Two copies of "30" is a screen that promises half an hour while the server
 * allows ten minutes, with nothing failing anywhere — the same shape as the
 * copy defects of #109, which nothing caught because copy has no assertions.
 *
 * This is a CONTRACT value, not domain logic: it is the shared kernel's proper
 * job (a number both sides must agree on), unlike the invoice statuses the
 * architecture note warns about.
 */
export const FORWARDING_ARMED_WINDOW_MINUTES = 30;

/**
 * Where a product's screens live. The ONLY way to build a product link.
 *
 * ⚠️ NEVER HAND-WRITE `/app/<slug>`. A literal path is a second copy of the
 * slug, and the moment one of them changes the other is a dead link nothing
 * fails on — `moduleHref` is what makes renaming a product a one-line edit.
 */
export function moduleHref(moduleKey: ModuleKey, section?: string): string {
  const base = `/app/${MODULE_CATALOGUE[moduleKey].slug}`;
  return section ? `${base}/${section}` : base;
}

/** Whether the product behind this key actually exists yet. */
export function isModuleLive(moduleKey: ModuleKey): boolean {
  return MODULE_CATALOGUE[moduleKey].live;
}

/**
 * The mediums Eva can reply on (slice 3.2b, founder ruling 63).
 *
 * ⚠️ THIS IS NOT `LEAD_SOURCES`, AND THE DIFFERENCE IS DIRECTION. `leads.source`
 * says `email_enquiry` and records how an enquiry ARRIVED; this records the
 * medium Eva REPLIES on. The same wire, opposite ways down it — and once
 * WhatsApp lands they stop even looking similar, because an enquiry can arrive
 * on one channel and (ruling 62's "one feature") be answered on the same one
 * while the customer holds three others.
 *
 * ⚠️ ONE VALUE, AND ADDING ONE IS A MIGRATION. The database CHECK
 * (`lead_reply_templates_channel_check`) lists exactly this set. Listing
 * `whatsapp` here before the channel exists would let a customer save a wording
 * nothing can ever send — ruling 57's objection to shipping templates early,
 * one level down.
 */
export const REPLY_CHANNELS = ["email"] as const;

export type ReplyChannel = (typeof REPLY_CHANNELS)[number];

/** What a customer sees this channel called. */
export const REPLY_CHANNEL_LABELS: Record<ReplyChannel, string> = {
  email: "Email",
};

export function isReplyChannel(value: string): value is ReplyChannel {
  return (REPLY_CHANNELS as readonly string[]).includes(value);
}

/**
 * Which channel an enquiry from this source should be answered on.
 *
 * 🚨 RETURNS `null` RATHER THAN GUESSING, AND THAT IS THE WHOLE POINT. An
 * unmapped source means a lead arrived by a route this code does not understand.
 * Falling back to `email` there would have Eva reply by email to somebody who
 * messaged on WhatsApp — to an address the lead may not even carry — in the
 * customer's name. A null is a recorded "not sent" with a reason, which is the
 * outcome ruling 32 asks for when Eva is unsure.
 */
export function replyChannelForLeadSource(source: string): ReplyChannel | null {
  return source === "email_enquiry" ? "email" : null;
}

/** How a module came to be enabled. `subscription` is written by Paddle
 *  webhooks later; the table stays authoritative for ENFORCEMENT and Paddle
 *  for BILLING, because deriving entitlement live from Paddle would let a
 *  Paddle outage disable every customer at once. */
export const MODULE_SOURCES = ["subscription", "manual", "trial"] as const;

export type ModuleSource = (typeof MODULE_SOURCES)[number];

/** GET /organisations/:id/modules — one entry per product, always all four,
 *  so the UI can show what is available to buy as well as what is held. */
export interface ModuleStatusDto {
  moduleKey: ModuleKey;
  enabled: boolean;
  source: ModuleSource | null;
  /** Units paid for. Meaningless while `enabled` is false. */
  seats: number;
  /** Units in use — connected mailboxes for the email credit controller.
   *  Null for products with nothing countable yet. */
  seatsUsed: number | null;
  enabledAt: string | null;
  disabledAt: string | null;
  /**
   * When a product switched off mid-period stops working — the end of the
   * period already paid for. Null when it is not scheduled to end.
   *
   * ⚠️ `enabled: true` WITH AN `endsAt` IS A REAL AND COMMON STATE, not a
   * contradiction: the customer has cancelled and is still using what they
   * bought. A screen that reads only `enabled` will tell them nothing is
   * changing. Turning it back on before this date clears it — no new charge,
   * no interruption.
   */
  endsAt: string | null;
  /** Products this one needs first, and which are not currently enabled. */
  missingDependencies: readonly ModuleKey[];
  /**
   * Machinery this product needs that is not set up yet.
   *
   * ⚠️ **NOT A REASON TO REFUSE THE SALE.** "Not entitled" (402 — you have not
   * bought it) and "not ready" (you own it, something is unconfigured) were one
   * code path until 2026-08-19, and collapsing them meant refusing to sell the
   * lead agent to anyone who had not already connected a mailbox. Sell it, say
   * what is missing, link the fix — the `noWorkingMailbox` pattern from 1.13.
   */
  missingCapabilities: readonly Capability[];
}

/** The machine-readable body of a 402, so the web app can show an upgrade
 *  prompt instead of a dead end. */
export interface ModuleNotEntitledBody {
  statusCode: 402;
  code: "module_not_entitled";
  /**
   * ⚠️ PLURAL, AND HOLDING **ANY ONE** OF THEM IS ENOUGH. Was a single key
   * until 2026-08-19. Now that the mailbox is carried by two products, naming
   * only the first would tell a customer to buy something they do not need —
   * and a 402 exists precisely to say what to buy.
   */
  modules: readonly ModuleKey[];
  message: string;
}

// --- Slice 1.2: invoice records ---

/**
 * The nine STORED invoice statuses (BRD 4.1; Phase 1.2 plan §7.1). Only these
 * ever appear in invoices.status (enforced by a CHECK constraint); changes go
 * through the invoices module state machine. Outcome statuses
 * (promise_to_pay … written_off) have no API path until slice 1.8.
 */
export const INVOICE_STORED_STATUSES = [
  "draft",
  "active",
  "paused",
  "cancelled",
  "promise_to_pay",
  "disputed",
  "partially_paid",
  "paid",
  "written_off",
] as const;

export type InvoiceStoredStatus = (typeof INVOICE_STORED_STATUSES)[number];

/**
 * The statuses in which Eva is CHASING an invoice (slice 1.6c, tasks 5-7).
 *
 * ⚠️ `partially_paid` IS ONE OF THEM, AND THAT IS THE WHOLE POINT OF RECORDING
 * A PAYMENT. Until this constant existed, four separate places asked
 * `status === "active"` — the schedule-time eligibility gate, two reconcile
 * sweep queries, and the display-status derivation. Moving a part-paid invoice
 * to `partially_paid` would therefore have made the scheduler drop it, the
 * sweep skip it, and its badge stop saying Overdue: recording that a debtor
 * paid half would have STOPPED Eva chasing the other half.
 *
 * That is exactly the defect migration 0019 was created to fix, arriving by the
 * back door. One list, imported everywhere, so the next status that ought to be
 * chased cannot be added in three places and forgotten in the fourth.
 */
export const CHASED_INVOICE_STATUSES = ["active", "partially_paid"] as const;

export type ChasedInvoiceStatus = (typeof CHASED_INVOICE_STATUSES)[number];

/** Is Eva chasing an invoice in this stored status? */
export function isChasedInvoiceStatus(status: string): status is ChasedInvoiceStatus {
  return (CHASED_INVOICE_STATUSES as readonly string[]).includes(status);
}

/**
 * The statuses in which the money is still OWED to the business.
 *
 * ⚠️ THIS IS NOT `CHASED_INVOICE_STATUSES`, AND CONFLATING THEM MISSTATES THE
 * BOOK IN BOTH DIRECTIONS. "Is Eva writing to this debtor" and "does this
 * debtor still owe us" are different questions. A PAUSED invoice is the plain
 * case: somebody stopped the chase over a query or a dispute, and the debt did
 * not stop existing. Totalling only the chased statuses under the word
 * "outstanding" therefore hides real money — the mistake made while fixing the
 * opposite mistake on 2026-08-12, when cancelled money was being counted IN.
 *
 * Out, and why: `draft` has not been sent to anybody, `cancelled` was voided,
 * `paid` is settled, and `written_off` is money the business has decided to
 * stop counting. In: everything else, including `disputed` — a contested
 * invoice is still a receivable until it is credited, and a credit-control
 * product that quietly drops disputes understates the very number it exists to
 * report.
 *
 * ⚠️ `promise_to_pay`, `disputed` AND `written_off` HAVE NO API PATH UNTIL
 * SLICE 1.8, so they cannot occur yet. They are listed now on purpose: this is
 * the list a future status gets added to, and the whole reason the constant
 * exists is that the last one was added in three places and forgotten in the
 * fourth.
 */
export const OWED_INVOICE_STATUSES = [
  "active",
  "paused",
  "promise_to_pay",
  "disputed",
  "partially_paid",
] as const;

export type OwedInvoiceStatus = (typeof OWED_INVOICE_STATUSES)[number];

/** Does an invoice in this stored status still represent money owed? */
export function isOwedInvoiceStatus(status: string): status is OwedInvoiceStatus {
  return (OWED_INVOICE_STATUSES as readonly string[]).includes(status);
}

/**
 * Time-derived statuses (plan §7.1): never stored — computed at read time
 * from due_date + the organisation timezone, and only ever applied to Active
 * invoices.
 */
export const INVOICE_COMPUTED_STATUSES = ["due_soon", "due_today", "overdue"] as const;

export type InvoiceComputedStatus = (typeof INVOICE_COMPUTED_STATUSES)[number];

/** What API responses expose: stored status, or a computed one when Active. */
export type InvoiceDisplayStatus = InvoiceStoredStatus | InvoiceComputedStatus;

// --- Slice 1.3: CSV/Excel invoice import ---

/**
 * The 5 MB upload cap (plan §3), enforced at the api's upload interceptor, in
 * the api's import service, and in the web upload action before a byte is sent.
 *
 * ⚠️ IT LIVES HERE BECAUSE IT IS ONE RULE ENFORCED ON BOTH SIDES. It used to be
 * declared twice — `apps/api/.../import-parser.ts` and
 * `apps/web/.../import-messages.ts` — each carrying a comment telling the reader
 * to keep it in step with the other. Nothing enforced that: raising one alone
 * would have web waving through a file the api then rejects, or web refusing a
 * file the api would have taken, and no test anywhere compares the two numbers.
 * A shared constant is the only version of "must match" a build can check.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Accepted import file types (plan §3). Legacy .xls (BIFF) is rejected. */
export const IMPORT_FILE_TYPES = ["csv", "xlsx"] as const;

export type ImportFileType = (typeof IMPORT_FILE_TYPES)[number];

/**
 * The four STORED import statuses (plan §3 — CHECK constraint in migration
 * 0007). 'confirmed' is not a stored state: confirm runs synchronously to
 * completion (plan §7.8). Status changes only via the imports module status
 * machine (the 1.2 pattern).
 */
export const IMPORT_STATUSES = ["uploaded", "completed", "failed", "cancelled"] as const;

export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** The staged-row statuses (plan §3 — CHECK constraint in migration 0007). */
export const IMPORT_ROW_STATUSES = [
  "valid",
  "invalid",
  "duplicate",
  "suppressed",
  "imported",
  "skipped",
] as const;

export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** One import upload as the API exposes it (list + preview/report header). */
export interface ImportSummary {
  id: string;
  originalFilename: string;
  fileType: ImportFileType;
  status: ImportStatus;
  /** Resolved file-column → canonical-field mapping (echoed from upload). */
  mapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  suppressedRows: number;
  createdRows: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One staged row as the API exposes it (preview before confirm; report after). */
export interface ImportRowView {
  id: string;
  /** 1-based position of the data row in the uploaded file. */
  rowNumber: number;
  /** The original file row (file column names → raw string values). */
  raw: Record<string, string>;
  status: ImportRowStatus;
  /** Row-level validation errors and informational flags (e.g. customer
   *  auto-creation, plan §7.2); empty when there is nothing to report. */
  errors: string[];
  /** The Draft invoice created at confirm (plan §7.7); null before confirm. */
  createdInvoiceId: string | null;
}

/** GET .../imports/:importId — preview before confirm, report after (plan §3). */
export interface ImportDetail extends ImportSummary {
  rows: ImportRowView[];
}

// --- Slice 1.4: PDF extraction ---

/** The four STORED invoice-document statuses (plan §3 — CHECK constraint in
 *  migration 0008). Status changes only via the invoice-documents module
 *  status machine (the 1.2/1.3 pattern). */
export const INVOICE_DOCUMENT_STATUSES = ["uploaded", "extracted", "confirmed", "failed"] as const;

export type InvoiceDocumentStatus = (typeof INVOICE_DOCUMENT_STATUSES)[number];

/**
 * The fields the extraction provider attempts to pull from a PDF (plan §3) —
 * the SAME ten canonical fields as the 1.3 import. This list deliberately
 * mirrors IMPORT_CANONICAL_FIELDS in @eva/validation (types must not depend
 * on validation); keep the two in sync.
 */
export const EXTRACTABLE_FIELDS = [
  "invoiceNumber",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
  "customerReference",
  "customerName",
  "customerEmail",
  "contactName",
  "contactEmail",
] as const;

export type ExtractableField = (typeof EXTRACTABLE_FIELDS)[number];

/** One extracted field: the raw string value (null when not found) plus a
 *  rule-derived confidence in [0, 1] (plan §3). */
export interface ExtractedFieldValue {
  value: string | null;
  confidence: number;
}

/** One uploaded invoice PDF as the API exposes it in lists (plan §3). The
 *  PDF bytes themselves are only ever streamed by the file endpoint. */
export interface InvoiceDocumentSummary {
  id: string;
  originalFilename: string;
  sizeBytes: number;
  status: InvoiceDocumentStatus;
  /** Sanitised, actionable failure reason when status is 'failed'. */
  extractionError: string | null;
  /** The Draft invoice created at confirm (plan §7.7); null before confirm. */
  invoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * GET .../invoice-documents/:documentId — the review payload (plan §3).
 * `extractedFields` and `extractionNotes` are both sourced from the
 * extracted_fields jsonb column: a `{ fields, notes }` document where fields
 * maps canonical field → { value, confidence } and notes carries extractor
 * remarks (e.g. multi-invoice detection, plan §7.3).
 */
export interface InvoiceDocumentDetail extends InvoiceDocumentSummary {
  /** Per-field extraction draft (null until extraction has run); missing or
   *  low-confidence entries are completed by the human at review (plan §7.7). */
  extractedFields: Partial<Record<ExtractableField, ExtractedFieldValue>> | null;
  extractionNotes: string[];
}

/**
 * ⚠️ `MODULE_IDS` / `ModuleId` LIVED HERE AND WERE DELETED 2026-08-19.
 *
 * A second enumeration of the same four products, declared in Slice 0.3 and
 * referenced by **nothing** — `grep` found the declaration and the type alias,
 * and no other file in the workspace. `MODULE_KEYS` above is the authoritative
 * list; this one had already fallen behind it.
 *
 * Two lists of the same thing is how the sidebar came to name products
 * differently from the settings screen. An unused copy is not harmless: it is
 * the copy somebody imports next, precisely because it looks official.
 */

// --- Slice 1.5: reminder sequence ---

/**
 * The six reminder stages (BRD 4.1; plan §3/§7.1) — CHECK constraint in
 * migration 0009. `final_escalation` is the internal handover to a human, not
 * a customer-facing email.
 */
export const REMINDER_STEP_KEYS = [
  "pre_due_3",
  "due_date",
  "overdue_7",
  "overdue_14",
  "overdue_30",
  "final_escalation",
] as const;

export type ReminderStepKey = (typeof REMINDER_STEP_KEYS)[number];

/** What a scheduled action does when it fires (plan §3) — CHECK in 0009. */
export const REMINDER_ACTION_TYPES = ["email", "internal_escalation"] as const;

export type ReminderActionType = (typeof REMINDER_ACTION_TYPES)[number];

/**
 * The full scheduled-action lifecycle (plan §3 — CHECK constraint in
 * migration 0009): slice 1.5 writes only pending/ready/cancelled;
 * claimed/sent/failed/skipped are driven by 1.7 via conditional-update claim.
 */
export const SCHEDULED_ACTION_STATUSES = [
  "pending",
  "ready",
  "claimed",
  "sent",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type ScheduledActionStatus = (typeof SCHEDULED_ACTION_STATUSES)[number];

/** Human escalation lifecycle (plan §3) — CHECK constraint in migration 0009. */
export const HUMAN_ESCALATION_STATUSES = ["open", "resolved"] as const;

export type HumanEscalationStatus = (typeof HUMAN_ESCALATION_STATUSES)[number];

/**
 * The default stage definitions (BRD 4.1; plan §3/§7.1) — the single source
 * of truth the API provisions for each organisation. Offsets are days
 * relative to the invoice due_date (negative = before); `final_escalation`
 * fires at +37, seven days after the last email stage.
 */
export const DEFAULT_REMINDER_STEPS: ReadonlyArray<{
  key: ReminderStepKey;
  offsetDays: number;
  actionType: ReminderActionType;
}> = [
  { key: "pre_due_3", offsetDays: -3, actionType: "email" },
  { key: "due_date", offsetDays: 0, actionType: "email" },
  { key: "overdue_7", offsetDays: 7, actionType: "email" },
  { key: "overdue_14", offsetDays: 14, actionType: "email" },
  { key: "overdue_30", offsetDays: 30, actionType: "email" },
  { key: "final_escalation", offsetDays: 37, actionType: "internal_escalation" },
];

/** One reminder step as the API exposes it (plan §3). */
export interface ReminderStepDto {
  id: string;
  key: ReminderStepKey;
  /** Days relative to the invoice due_date (negative = before). */
  offsetDays: number;
  actionType: ReminderActionType;
  enabled: boolean;
}

/** GET .../reminder-sequence — the org's sequence with its steps (plan §3). */
export interface ReminderSequenceDto {
  id: string;
  name: string;
  isDefault: boolean;
  steps: ReminderStepDto[];
}

/** One scheduled action as the API exposes it (plan §3). */
export interface ScheduledActionDto {
  id: string;
  invoiceId: string;
  reminderStepId: string;
  actionType: ReminderActionType;
  /** Calendar date (YYYY-MM-DD) in the organisation timezone. */
  scheduledDate: string;
  status: ScheduledActionStatus;
  idempotencyKey: string;
}

// --- Slice 1.7: what Eva actually did ---

/**
 * Why due reminders have not gone out, DERIVED at read time from the
 * organisation's mailbox health — never stored on the row.
 *
 * A stamped answer would be right on the day it was written and wrong the
 * moment somebody reconnected a mailbox, which is the same trap the client
 * allocation resolver documents.
 */
export type ReminderWaitingReason = "no_working_mailbox" | "unknown";

/** One line of chase history, joined to the invoice a reader recognises. */
export interface ReminderActivityRowDto {
  id: string;
  invoiceId: string;
  customerId: string;
  invoiceNumber: string;
  customerName: string;
  stageKey: ReminderStepKey;
  actionType: ReminderActionType;
  /** Calendar date (YYYY-MM-DD) in the organisation timezone. */
  scheduledDate: string;
  status: ScheduledActionStatus;
  /** When the row last changed state — when it SENT, for a sent row. */
  updatedAt: string;
}

/**
 * The chase activity screen (Slice 1.7). Answers the question no screen could
 * answer before it: has Eva actually chased anybody?
 */
export interface ReminderActivityDto {
  counts: {
    sentLast7Days: number;
    /** Due, still `ready` — should have gone out and has not. */
    waiting: number;
    failedLast7Days: number;
    /**
     * Still to come: every `pending` action Eva holds.
     *
     * ⚠️ NOT DATE-FILTERED, DELIBERATELY. A `pending` row dated in the PAST
     * means the scheduler did not promote it, which is a fault worth seeing
     * rather than a row worth hiding. Filtering to the future would make the
     * one state that indicates something is broken the one state nothing
     * counts.
     */
    scheduled: number;
  };
  /** Null when nothing is waiting; otherwise why, as far as we can tell. */
  waitingReason: ReminderWaitingReason | null;
  /**
   * Whether the organisation has NO healthy mailbox right now.
   *
   * ⚠️ THE PLAN IS A PROMISE, AND THIS IS WHETHER WE CAN KEEP IT. Listing what
   * Eva will send next without saying there is nowhere to send it from is the
   * same defect as an upload preview that disagrees with the upload: a screen
   * stating an outcome that will not happen.
   */
  noWorkingMailbox: boolean;
  recent: ReminderActivityRowDto[];
  /**
   * What Eva will do next, soonest first — the near horizon, not the whole
   * plan. `counts.scheduled` is the whole plan.
   *
   * ⚠️ THIS EXISTS BECAUSE EVA'S FUTURE WORK WAS INVISIBLE (found by walking,
   * 2026-08-18). Slice 1.7 made the PAST visible and stopped there, so a book
   * whose invoices were not due yet — which is every new customer for their
   * first weeks — showed three zeroes and "Eva simply has not needed to write
   * to anybody", with six reminders sitting scheduled in the database. A
   * product that has a plan and a product that has none looked identical.
   */
  upcoming: ReminderActivityRowDto[];
}

/** One human escalation as the API exposes it (plan §3). */
export interface HumanEscalationDto {
  id: string;
  invoiceId: string;
  scheduledActionId: string;
  reason: string;
  status: HumanEscalationStatus;
  /** ISO-8601 UTC timestamp; null until resolved. */
  resolvedAt: string | null;
  /** Resolving user's id; null until resolved. */
  resolvedBy: string | null;
  /** Resolution notes; null until supplied. */
  notes: string | null;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
}

// --- Slice 1.6: Outlook connection ---

/** Mailbox providers (plan §3; CHECK constraint in migration 0013). */
export const EMAIL_ACCOUNT_PROVIDERS = ["microsoft"] as const;

export type EmailAccountProvider = (typeof EMAIL_ACCOUNT_PROVIDERS)[number];

/** Connection health (plan §7.10; CHECK constraint in migration 0013). */
export const EMAIL_ACCOUNT_HEALTH_STATUSES = ["active", "auth_expired", "error"] as const;

export type EmailAccountHealthStatus = (typeof EMAIL_ACCOUNT_HEALTH_STATUSES)[number];

/**
 * GET .../mailbox — the sanitized connection status (plan §3). Tokens are
 * NEVER exposed; `connected: false` collapses every other field to null.
 */
/**
 * ONE connected mailbox (Slice 1.6a — was a single nullable status object).
 *
 * An organisation may now hold as many as it has seats for, so every field
 * that used to be "null when nothing is connected" is simply present: an empty
 * list means nothing is connected, and each entry describes a real mailbox.
 */
export interface MailboxDto {
  id: string;
  provider: EmailAccountProvider;
  emailAddress: string;
  displayName: string | null;
  healthStatus: EmailAccountHealthStatus;
  /**
   * The organisation's DEFAULT mailbox — the one that chases any client with no
   * allocation of its own (slice 1.6b, ruling 1). Exactly one per organisation.
   *
   * Renamed in meaning, not in shape: before 1.6b this was "the only mailbox
   * that sends". Every seat sends now, so UI copy calling this "sends from this
   * one" is wrong.
   */
  isPrimary: boolean;
  /** How many clients are filed under this mailbox (slice 1.6b). Excludes the
   *  unallocated ones that merely fall back to the default. */
  allocatedClientCount: number;
  /** ISO-8601 UTC timestamp; null until a test email / send attempt runs. */
  lastHealthCheckAt: string | null;
  /** Sanitized, actionable message (e.g. "reconnect the mailbox"); null when healthy. */
  lastError: string | null;
  /** Connecting user's id. */
  connectedBy: string | null;
  /** ISO-8601 UTC timestamp. */
  connectedAt: string;
}

/** GET .../mailboxes — the list, plus what the organisation may hold. */
export interface MailboxListDto {
  mailboxes: MailboxDto[];
  /** Seats bought for the email credit controller. */
  seats: number;
  /** True when `mailboxes.length >= seats` — the UI hides Connect rather than
   *  letting someone consent at Microsoft for nothing. */
  seatLimitReached: boolean;
}

/** POST .../mailboxes/connect — the Microsoft authorize URL to redirect the browser to. */
export interface MailboxConnectDto {
  authorizeUrl: string;
}

/** POST .../mailboxes/:mailboxId/test-email — self-addressed send (ruling 7). */
export interface MailboxTestEmailResultDto {
  sent: true;
  to: string;
}

// --- Slice 1.6b: client allocation across mailbox seats ---

/**
 * POST .../mailboxes/:mailboxId/disconnect.
 *
 * `clientsMoved` exists because ruling 3 forbids a silent move: when a mailbox
 * goes, its clients fall back to the default, and the customer is told how many
 * did. Discovering months later that a book of clients quietly changed the
 * address they are chased from is the failure this number prevents.
 */
export interface MailboxDisconnectResultDto {
  /** Clients that were FILED under the disconnected mailbox and have been
   *  un-filed back to the default. */
  clientsMoved: number;
  /**
   * Clients that were never filed anywhere and have ALSO changed address,
   * because the mailbox disconnected was the default and another was promoted.
   *
   * Counted separately, and it is usually the bigger number: ruling 1 sends
   * every unallocated client from the default, so disconnecting the default
   * re-routes everyone who was never filed. Reporting only `clientsMoved`
   * would say "0 clients moved" while several hundred quietly changed the
   * address they are chased from — exactly the silence ruling 3 forbids.
   */
  unfiledClientsMoved: number;
  /** Where they went — null when the organisation has no mailbox left at all. */
  movedToEmailAddress: string | null;
}

/**
 * One row of the allocation screen (slice 1.6b, ruling 2 — per client, never
 * per invoice).
 */
export interface CustomerAllocationDto {
  customerId: string;
  customerName: string;
  /** NULL means unallocated — this client is chased from the DEFAULT mailbox
   *  (ruling 1). It is a real, normal state and not a missing value. */
  emailAccountId: string | null;
  /**
   * The address this client would actually be chased from today, resolved now
   * and NEVER stored — a stamped answer goes stale the moment the default
   * changes (ALLOCATION-SCOPE trap 1). Null when the organisation has no
   * healthy mailbox at all, which is the case the UI must warn about loudly.
   */
  resolvedEmailAddress: string | null;
  /** True when `resolvedEmailAddress` came from the default rather than from an
   *  allocation of this client's own. Lets the screen show "Default (…)"
   *  distinctly from a deliberate filing. */
  isFallback: boolean;
}

/** GET .../customers/allocation — the whole book, with who chases whom. */
export interface CustomerAllocationListDto {
  allocations: CustomerAllocationDto[];
  /** The default mailbox's address, for the "Default (…)" label. Null when the
   *  organisation has no live mailbox. */
  defaultEmailAddress: string | null;
}

/** PUT .../customers/allocation — what actually moved. */
export interface AllocateClientsResultDto {
  /** Rows whose allocation genuinely changed. Re-filing a client under the
   *  mailbox it is already on counts as zero, so the UI never claims work it
   *  did not do. */
  moved: number;
}

/**
 * The most clients one allocation request may carry.
 *
 * Bounded so a single request cannot open an unbounded transaction: the whole
 * batch commits together (trap 3 — 500 clients must not be 500 commits), and an
 * unbounded batch would hold row locks across the entire customers table for as
 * long as it took. 500 is comfortably above any real book handled in one screen.
 */
export const MAX_CLIENTS_PER_ALLOCATION = 500;

/** What kind of Microsoft account an address belongs to (onboarding Part A). */
export const MICROSOFT_ACCOUNT_KINDS = ["work", "personal", "unknown"] as const;

export type MicrosoftAccountKind = (typeof MICROSOFT_ACCOUNT_KINDS)[number];

/**
 * GET .../mailboxes/admin-consent — what to show someone whose connection was
 * declined (defect F1).
 *
 * Microsoft reports "your administrator must approve this" and "you pressed
 * cancel" identically, so the callback cannot tell them apart and the UI must
 * offer both readings. This endpoint supplies the administrator half.
 *
 * `url` is null for a `personal` account: there is no administrator to ask, and
 * sending a sole trader looking for an IT department is worse than saying
 * nothing. The URL is always built server-side from constants — never echoed
 * back from a query parameter — so it cannot be steered at a hostile host.
 */
export interface MailboxAdminConsentDto {
  accountKind: MicrosoftAccountKind;
  /** Tenant-specific approval link where the tenant is known, the generic
   *  `organizations` form otherwise, null when no administrator can exist. */
  url: string | null;
  /** The customer's own organisation name, for copy that names them. */
  organisationName: string | null;
}

// --- Session lifetime (founder's request, 2026-08-12) ---

/**
 * How long a session survives with NO activity before it is ended.
 *
 * ⚠️ SUPABASE CANNOT DO THIS FOR US ON THE FREE PLAN. Their "inactivity
 * timeout" is a Pro-plan setting, so the rule lives here — which is better
 * anyway: enforced in our own API against a stored timestamp, it holds against
 * a stolen token, whereas anything the browser carries can be replayed with it.
 */
export const SESSION_IDLE_TIMEOUT_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * How stale `users.last_seen_at` may get before a request bothers to write it.
 *
 * ⚠️ A WRITE ON EVERY REQUEST WOULD BE FIVE WRITES PER SCREEN. The dashboard
 * asks five questions to draw itself. Five minutes of imprecision costs nothing
 * against a two-day window and turns that into one write.
 */
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** The code on the 401 an idle session gets, so a caller can branch on it. */
export const SESSION_IDLE_TIMEOUT_CODE = "session_idle_timeout";

/** The machine-readable body of that 401. */
export interface SessionIdleTimeoutBody {
  statusCode: 401;
  code: typeof SESSION_IDLE_TIMEOUT_CODE;
  message: string;
}

/**
 * Has a session with this last-activity stamp gone idle?
 *
 * ⚠️ NULL IS FRESH, NOT ANCIENT, AND GETTING THAT BACKWARDS SIGNS EVERYBODY
 * OUT. Every existing row has no `last_seen_at` the moment the column ships;
 * reading "unknown" as "idle since the epoch" would end every live session on
 * deploy. The first request stamps it instead.
 *
 * Shared by the API (which enforces it) and the web proxy (which acts on it) so
 * one rule cannot drift into two.
 */
export function isSessionIdle(lastSeenAt: Date | null | undefined, now: Date): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_MS;
}

// --- Slice 3.1c-1: the words Eva replies with ---

/**
 * One reply template as the API exposes it.
 *
 * ⚠️ `isAutomatic` IS THE ONLY FIELD WITH TEETH. It marks the single wording
 * Eva sends unattended (ruling 55); the others are saved wordings a human picks
 * from the enquiry screen. Exactly one row per organisation may carry it, and
 * that is enforced by a partial unique index rather than by this type.
 */
export interface LeadReplyTemplateDto {
  id: string;
  /**
   * Which medium this wording is for (slice 3.2b). ⚠️ **Set once, at creation,
   * and never changeable** — a wording is written FOR a medium, so moving one
   * would make it wrong rather than merely misfiled. `UpdateLeadReplyTemplateInput`
   * omits the field entirely for that reason.
   */
  channel: ReplyChannel;
  name: string;
  body: string;
  isAutomatic: boolean;
  /** ISO 8601. Shown as "last edited" so a customer can tell theirs from ours. */
  updatedAt: string;
}

/**
 * GET .../lead-reply-templates.
 *
 * ⚠️ `automaticTemplateIds` IS DERIVED, AND ITS NULLS ARE LOAD-BEARING. A
 * customer can turn the automatic reply off entirely, and the screen has to say
 * so plainly — "Eva will not reply on her own" is a state somebody chose, not
 * an error. The sender must be able to DETECT it rather than guess, which is
 * why it is a field here and not something the caller works out by scanning.
 *
 * ⚠️ IT BECAME A MAP IN SLICE 3.2b, AND A SINGLE ID WOULD NOW BE A BUG. Ruling
 * 63 makes the automatic reply per CHANNEL. One id could only ever describe one
 * of them, so a customer with email answering and WhatsApp silent would look
 * identical to one with both answering — on the screen whose whole job is
 * saying which.
 *
 * Every channel in `REPLY_CHANNELS` is always present, so "no automatic reply"
 * and "no such channel" stay different shapes.
 */
export interface LeadReplyTemplatesDto {
  templates: LeadReplyTemplateDto[];
  automaticTemplateIds: Record<ReplyChannel, string | null>;
}

/**
 * How many templates one organisation may keep **per channel**.
 *
 * ⚠️ A LIMIT, NOT A TARGET. The founder's model is "2–3 the customer edits" and
 * three ship by default; the cap exists so a list stays something a person
 * picks from at the moment they are answering an enquiry. Ten is well past
 * anything asked for and still short of a filing system.
 *
 * ⚠️ PER CHANNEL SINCE SLICE 3.2b. Counted across channels, a customer's email
 * wordings would eat the budget for their WhatsApp ones — so connecting a
 * second channel could refuse the first wording written for it, citing a limit
 * the customer would have to visit another screen to understand.
 */
export const MAX_LEAD_REPLY_TEMPLATES = 10;
