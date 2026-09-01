/**
 * Which product a screen belongs to, for the log and for Sentry.
 *
 * ⚠️ THE WEB HALF OF SLICE 3.0C, AND THE HALF CUSTOMERS ACTUALLY SEE. The API
 * derives its owner from the controller's folder via `@OwnedBy`; a Next route
 * has no controller to annotate, so the map is the URL. It is written out by
 * hand and `product-owner.spec.ts` fails the build when a route folder appears
 * that nobody has attributed — the same shape of wall, in the place where the
 * mistake would otherwise be invisible.
 *
 * ⚠️ THE URL SEGMENT AND THE CODE FOLDER ARE NOT THE SAME WORD, WHICH IS
 * EXACTLY WHY THIS FILE EXISTS. The invoice product lives at
 * `/app/invoice-chasing` (its customer-facing slug) and its code lives in
 * `src/products/invoice-follow-up`. The tag names the FOLDER, matching the API,
 * so one search finds both halves of a product; deriving it from the slug would
 * split every search in two the day a product is renamed for marketing.
 */
export type OwnerTag = "platform" | `capability:${string}` | `product:${string}`;

/** What an unmapped route reports. Searchable on purpose — see the API's
 *  `common/monitoring/owner.ts` for why this is a value and not an omission. */
export const UNATTRIBUTED = "unattributed";

/** The invoice product's tag. The folder name, not the URL slug. */
const INVOICE_FOLLOW_UP: OwnerTag = "product:invoice-follow-up";

/**
 * The lead product's tag. The folder name, not the URL slug.
 *
 * ⚠️ THIS WAS `product:lead-follow-up` AND IT WENT STALE THE MOMENT #130
 * RENAMED THE FOLDER, on 2026-09-01. The API tags its lead controller
 * `product:lead-follow-up-email` (derived from its folder, and enforced by
 * `product-attribution.spec.ts`); this side is hand-written and was enforced by
 * nothing, so for a day the two apps filed one product under two names —
 * exactly what the note above this map says must never happen.
 *
 * The old comment argued the two words were "further apart than ever" because
 * the code folder would be shared by email and call. **That is no longer the
 * plan:** ruling 14 makes Lead Follow-up by CALL a product a customer buys
 * separately, which is why #130 renamed the folder in the first place.
 *
 * ⚠️ AND THE FOLDER NAME LIVES IN THREE PLACES, NOT TWO. The handoff said
 * two (the folder, and `PRODUCT_FOLDERS` in `.dependency-cruiser.web.cjs`).
 * This constant is the third, and the only one no wall was watching — the test
 * below now compares it, so the next rename cannot leave it behind.
 */
const LEAD_FOLLOW_UP: OwnerTag = "product:lead-follow-up-email";

/**
 * Route folders directly under `/app`, and who owns them.
 *
 * ⚠️ EVERY FOLDER UNDER `src/app/app/` MUST APPEAR HERE. The spec reads the
 * directory listing and compares — add a route, and the build tells you to
 * attribute it rather than letting it log as nobody's.
 */
const APP_SECTIONS: Record<string, OwnerTag> = {
  "invoice-chasing": INVOICE_FOLLOW_UP,
  "lead-follow-up-email": LEAD_FOLLOW_UP,
  clients: "platform",
  settings: "platform",
  organisations: "platform",
  onboarding: "platform",
};

/**
 * ⚠️ THE TWO PLATFORM ROUTES THAT RENDER A PRODUCT'S SCREENS. The same two the
 * web wall records in `.dependency-cruiser.web.cjs`, for the same reason: the
 * honest fix moves them under the product's slug and that changes
 * customer-facing URLs, which is the founder's call.
 *
 * They are attributed to the PRODUCT, not to the platform whose URL they sit
 * on, because this tag answers "whose code broke" — and when a client's invoice
 * list fails, the thing that failed is invoice follow-up. Tagging by the URL
 * would file the product's own defects under the platform, which is the one
 * outcome that makes the tag worse than nothing.
 *
 * ⚠️ NOTHING MAY BE ADDED HERE WITHOUT A REASON WRITTEN NEXT TO IT, and the
 * spec fails if a third appears without one.
 */
const CROSSINGS: { prefix: string; owner: OwnerTag }[] = [
  // A client's invoices. Clients are platform (one client record, BRD §3.1.3);
  // their invoices are the product's.
  { prefix: "/app/clients/[customerId]/invoices", owner: INVOICE_FOLLOW_UP },
  // Reminder timing: platform settings holding one product's configuration.
  { prefix: "/app/settings/reminders", owner: INVOICE_FOLLOW_UP },
  /**
   * Each product's mailbox screen (slice 3.1c-0) — a PRODUCT url rendering the
   * mailbox capability's screen, which is the mirror image of the two above.
   *
   * Both routes render the same `MailboxScreen`, so without these a single
   * defect in that one component would be filed under Invoice Chasing or under
   * Lead Follow-up depending on which door the customer walked through — the
   * same bug, two owners, and neither search finds both. `/microsoft-approved`
   * is already tagged this way for exactly this reason.
   */
  { prefix: "/app/invoice-chasing/mailbox", owner: "capability:mailbox" },
  { prefix: "/app/lead-follow-up-email/mailbox", owner: "capability:mailbox" },
];

/** Routes outside `/app` — sign-in, the auth callbacks, the Microsoft landing
 *  page. Matched longest-first, so `/microsoft-approved` wins over `/`. */
const OUTSIDE_APP: { prefix: string; owner: OwnerTag }[] = [
  // Where Microsoft returns an administrator after granting consent: the
  // mailbox capability's screen, not any one product's.
  { prefix: "/microsoft-approved", owner: "capability:mailbox" },
  { prefix: "/auth", owner: "platform" },
];

/**
 * The owner of a route.
 *
 * Takes Next's `routePath` where one is available (`/app/clients/[customerId]`)
 * and a plain pathname otherwise — the two are the same string for every route
 * with no dynamic segment, and the crossings below are written in the bracketed
 * form because that is what `onRequestError` reports.
 */
export function ownerForRoute(route: string): OwnerTag | typeof UNATTRIBUTED {
  const path = route.split("?")[0] ?? "";

  for (const { prefix, owner } of CROSSINGS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return owner;
  }

  if (path === "/app" || path.startsWith("/app/")) {
    const section = path.split("/")[2];
    // `/app` itself is the hub: platform, and the screen that routes somebody
    // into a product without belonging to one.
    if (!section) return "platform";
    return APP_SECTIONS[section] ?? UNATTRIBUTED;
  }

  for (const { prefix, owner } of OUTSIDE_APP) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return owner;
  }

  // The marketing front door, sign-in, sign-up, password screens: all platform,
  // and all of them exist before a customer holds any product at all.
  return "platform";
}

/** Exposed for the spec that checks every route folder is attributed. */
export const ATTRIBUTED_APP_SECTIONS = Object.keys(APP_SECTIONS);
