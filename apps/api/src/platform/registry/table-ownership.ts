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
  "role",
  "organisationMembership",
  "auditLog",
  "customer",
  "contact",
  "suppressionEntry",
  "organisationRolePermission",
  "organisationModule",
] as const;

/** Shared machinery. Owned by a capability, not by any product. */
export const CAPABILITY_TABLES = {
  mailbox: ["emailAccount"],
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
