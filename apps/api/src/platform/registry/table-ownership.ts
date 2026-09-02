/**
 * Which layer owns which table (BRD §8, "Data boundaries").
 *
 * ⚠️ THE IMPORT RULES CANNOT SEE DATABASE ACCESS, AND THAT IS WHY THIS EXISTS.
 * `pnpm boundaries` catches a product importing another product's *code*.
 * Prisma is a single shared client, so `tx.invoice.findMany()` inside the
 * platform is invisible to it — a boundary crossed through the database looks
 * exactly like ordinary data access. `architecture.spec.ts` is the wall for
 * that half.
 *
 * Names are the Prisma model accessors used in code (`tx.emailAccount`), not
 * the SQL table names (`email_accounts`).
 */

/** The shared base. Every layer may read these — that is what a base is. */
export const PLATFORM_TABLES = [
  "organisation",
  "organisationSettings",
  "user",
  /**
   * Sign-in sessions and their activity clocks (migration 0033). Platform, and
   * not a product's business, for the same reason `user` is: it is who is at the
   * keyboard, which every product needs and none of them owns.
   */
  "userSession",
  "role",
  "organisationMembership",
  "auditLog",
  "customer",
  "contact",
  "suppressionEvent",
  "organisationRolePermission",
  "organisationModule",
  /**
   * ⚠️ THE LEAD RECORD IS PLATFORM, NOT THE LEAD PRODUCT'S — and this is the
   * decision to argue with if any of this ever feels wrong (3.1a, 2026-08-20).
   *
   * The founder already ruled it for clients: "Clients stay OUTSIDE the
   * products (one client record) or a lead-only customer cannot reach their own
   * contacts." A lead is the same kind of thing — a person who got in touch —
   * and THREE products will want the same one: follow-up by email, follow-up by
   * call (ruling 14 makes them separate purchases), and the CRM that ruling 16
   * says every structural decision must be checked against. Two lead books for
   * one enquiry is the failure that ruling avoided for clients.
   *
   * The RECORD is platform; ACCESS is product-gated. `leads:read` and
   * `leads:write` are carried by `lead_follow_up` alone today
   * (`PERMISSION_MODULES`), so a customer holding only invoice chasing gets
   * nothing — the table being shared is not the same as the data being open.
   *
   * What the lead PRODUCT will own is the machinery of ANSWERING: classifying
   * an enquiry (ruling 32 — reply to genuine enquiries, never to spam), the
   * templates a customer edits, and sending the reply. That lives under
   * `products/` when 3.1c builds it.
   *
   * ⚠️ AMENDED 2026-08-21: THIS USED TO SAY "READING THE MAILBOX" TOO, AND
   * 3.1b PUT THAT SOMEWHERE ELSE. Receiving mail turned out to be the same KIND
   * of thing as sending it, so it sits in the mailbox CAPABILITY beside
   * `emailAccount` — which is why there is still no `products/` folder for
   * leads after 3.1b. A product folder whose only content is a call into the
   * platform is a folder pretending to be a boundary.
   */
  "lead",
  "leadEvidence",
  "consentText",
] as const;

/**
 * Shared machinery. Owned by a capability, not by any product.
 *
 * ⚠️ THE INBOUND PAIR IS THE CAPABILITY'S, NOT THE LEAD PRODUCT'S, AND THAT IS
 * A DELIBERATE CALL (3.1b, 2026-08-21). Receiving mail is the same KIND of
 * thing as sending it — `emailAccount` is already here for the sending half —
 * and the split falls where it does for sending too: the machinery moves the
 * message, the product decides what it MEANS. `inbound_addresses` is a door we
 * own; `inbound_messages` is what came through it. Neither knows what a lead is.
 *
 * The practical consequence is the point: when Lead Follow-up by CALL or the
 * CRM wants mail, nothing moves. And a product is still free to read these —
 * "products may use machinery they pay for" is the rule `architecture.spec.ts`
 * encodes — so the lead product marking a message converted is ordinary use,
 * not a crossing.
 */
export const CAPABILITY_TABLES = {
  mailbox: ["emailAccount", "inboundAddress", "inboundMessage", "inboundForwardingRequest"],
} as const;

/**
 * ⚠️ KNOWN CROSSINGS, RECORDED RATHER THAN PRETENDED AWAY (2026-08-19).
 *
 * The platform reads `emailAccount`, which belongs to the mailbox capability.
 * The rule says dependencies point inward, so this is backwards.
 *
 * - `platform/entitlements` counts connected mailboxes for `seatsUsed`.
 * - `platform/customers` files clients under a mailbox (slice 1.6b allocation).
 *
 * **Not fixed here, deliberately.** The honest fix inverts the dependency — the
 * capability reports its own usage to the platform rather than the platform
 * reaching in — and that is a design change, not a file move. Doing it while
 * also moving thirteen folders would mean neither could be reviewed. It is
 * recorded so it stays visible, and the test below fails if the list grows.
 *
 * ⚠️ **NOTHING MAY BE ADDED HERE WITHOUT A REASON WRITTEN NEXT TO IT.** An
 * exception list that grows silently is how a boundary dies politely.
 */
export const ALLOWED_CROSSINGS: readonly { layer: string; table: string; why: string }[] = [
  {
    layer: "platform/entitlements",
    table: "emailAccount",
    why: "counts connected mailboxes for seatsUsed; needs the capability to report usage instead",
  },
  {
    layer: "platform/customers",
    table: "emailAccount",
    why: "client-to-mailbox allocation (slice 1.6b); same inversion needed",
  },
];
