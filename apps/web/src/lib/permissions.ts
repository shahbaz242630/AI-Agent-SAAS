/**
 * What the signed-in person may do here (slice 1.6c, task 8).
 *
 * ⚠️ THE ANSWER COMES FROM THE API AND IS NEVER WORKED OUT HERE. Every
 * organisation summary carries the caller's own `permissions`, resolved by the
 * same function the API's guards use. The tempting alternative is to read
 * `roleKey` and consult `DEFAULT_ROLE_PERMISSIONS` from `@eva/types` — it is
 * one import, it type-checks, and it is WRONG for any organisation that has
 * customised its mapping, because the BRD matrix is only the fallback. An org
 * that has granted `sales` the right to raise invoices would still have the
 * button hidden from the person who may use it. That is not a hypothetical:
 * `invoices.spec.ts` has tested the override path since slice 1.1.
 *
 * ⚠️ HIDING A CONTROL IS NOT ENFORCEMENT. The API refuses the request whether
 * or not this module agrees, because a server action is reachable by direct
 * POST. This exists so nobody is offered a button that can only fail — and so
 * the screen can say WHY it is not there, which is the part a customer needs.
 *
 * ⚠️ THIS IS THE ROLE HALF ONLY. It says nothing about whether the organisation
 * holds Invoice Chasing. A page learns that from its own 402 and shows the
 * upgrade prompt instead. The two must not be merged: "ask an owner" and "you
 * haven't got this product" are different problems with different fixes, and
 * naming the wrong one is the standing §0d mistake.
 */

/** The permission keys the invoice, import and chasing screens branch on. */
export type WebPermissionKey =
  | "customers:read"
  | "customers:write"
  | "contacts:read"
  | "contacts:write"
  | "invoices:read"
  | "invoices:write"
  | "imports:read"
  | "imports:write"
  // Slice 1.7 — the chase activity screen. Read-only: nothing on that page
  // writes, so there is deliberately no `reminders:write` here until a screen
  // needs it.
  | "reminders:read";

/** The shape every page already fetches from `GET /organisations`. */
export interface OrganisationAccess {
  name: string;
  permissions?: string[];
}

/**
 * Whether the caller holds a permission in this organisation.
 *
 * ⚠️ FAILS CLOSED ON A MISSING LIST. `permissions` is optional only because an
 * older API build would not send it, and the safe reading of "I don't know" is
 * "not allowed" — the same rule entitlement follows (§0d). The cost of being
 * wrong that way is a hidden button and a visible explanation; the cost of the
 * other way is a button that 403s.
 */
export function can(organisation: OrganisationAccess, permission: WebPermissionKey): boolean {
  return organisation.permissions?.includes(permission) ?? false;
}

/**
 * The line shown where the write controls would have been.
 *
 * ⚠️ SAID, NOT SILENTLY OMITTED. A read-only colleague who simply cannot find
 * "Add an invoice" assumes the product is broken or that they have missed a
 * step; one who is told their role cannot raise invoices knows exactly who to
 * ask. This is the `/app/clients` precedent — "your role can see clients but
 * not mailbox settings, so which mailbox chases whom is hidden" — applied to
 * the invoice screens.
 *
 * Names the organisation because a person can belong to more than one, and
 * being read-only in one of them is not being read-only everywhere.
 */
export function readOnlyInvoicesLine(organisationName: string): string {
  return `Your role can see ${organisationName}'s invoices but not change them, so adding, editing and recording payments are hidden. Ask an owner or administrator if you need them.`;
}

/** The same, for the upload and import screens (`imports:write`). */
export function readOnlyImportsLine(organisationName: string): string {
  return `Your role can see ${organisationName}'s uploads but not create or confirm them. Ask an owner or administrator if you need to import invoices.`;
}

/**
 * What a refused write should SAY, when one gets through anyway.
 *
 * ⚠️ THE API'S OWN 403 MESSAGE IS NOT FIT TO SHOW A CUSTOMER. It reads
 * `Role 'sales' lacks permission 'invoices:write' in this organisation` — a
 * true, deliberate, PUBLIC string (standing rule §0d) written for whoever is
 * reading a log or a test failure. Putting it on screen asks a credit
 * controller to parse a permission key to find out that they need to ask their
 * boss. Every other status keeps the API's wording, which is written for people
 * and carries detail this layer does not have.
 *
 * Returns `null` when the API's message should be used unchanged.
 */
export function humanRefusal(status: number | undefined, action: WriteAction): string | null {
  if (status !== 403) return null;
  return `${REFUSED[action]} Ask an owner or administrator.`;
}

/** The write a person was attempting, so the refusal can name it. */
export type WriteAction =
  | "create-invoice"
  | "edit-invoice"
  | "record-payment"
  | "change-invoice"
  | "add-row"
  | "upload-import"
  | "confirm-import"
  | "cancel-import"
  | "change-settings";

/**
 * ⚠️ `Record<WriteAction, string>` IS THE EXHAUSTIVENESS GUARANTEE. Adding a
 * write action without a sentence for it is a compile error, not a refusal that
 * falls back to a permission key at the moment someone is stuck.
 */
const REFUSED: Record<WriteAction, string> = {
  "create-invoice": "Your role can't raise invoices.",
  "edit-invoice": "Your role can't edit invoices.",
  "record-payment": "Your role can't record payments.",
  // Pause, resume, cancel — named by what they have in common rather than
  // guessing which one was clicked, because one sentence that is true of all
  // three beats three that could each be shown for the wrong action.
  "change-invoice": "Your role can't start, pause or cancel chasing an invoice.",
  "add-row": "Your role can't add invoices.",
  "upload-import": "Your role can't upload invoices.",
  "confirm-import": "Your role can't import invoices.",
  "cancel-import": "Your role can't discard an upload.",
  "change-settings": "Your role can't change invoice settings.",
};
