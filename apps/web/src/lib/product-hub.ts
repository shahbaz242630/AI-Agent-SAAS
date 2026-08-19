import { MODULE_CATALOGUE, MODULE_KEYS, type ModuleKey } from "@eva/types";

/**
 * How the hub sorts the catalogue against what an organisation holds.
 *
 * ⚠️ PULLED OUT OF `app/app/page.tsx` SO A TEST CAN REACH IT (2026-08-19).
 * The hub is an async server component that redirects and fetches, which makes
 * it unrenderable in a plain node test — so its rules were covered by nothing,
 * and a product the customer HOLDS vanished from the screen entirely without a
 * single test noticing. Same move as `SidebarBody` taking the path as a prop:
 * when something is easy to get wrong and impossible to see, put it where a
 * test can reach it.
 *
 * This is PLATFORM logic, not a product's — it knows module keys and the
 * catalogue, never one product's domain — so it belongs in `lib/`.
 */

export interface HubGroups {
  /** Held and built: cards you can click into. */
  readonly yours: readonly ModuleKey[];
  /**
   * ⚠️ HELD AND NOT BUILT — THE STATE THAT FELL THROUGH BOTH LISTS.
   *
   * The hub asked for "live AND held" and "NOT held", and a product that is
   * held but unbuilt is in neither, so it appeared NOWHERE while the sidebar
   * three inches away showed it lit and linked it to a bare 404. Reachable
   * today: rows for unbuilt products survive from before the phantom-products
   * fix, when the screen still offered them — the founder's own organisation
   * has one.
   */
  readonly heldNotReady: readonly ModuleKey[];
  /** Not held: "Off" if we built it, "Coming soon" if we have not. */
  readonly available: readonly ModuleKey[];
}

/**
 * ⚠️ EVERY KEY LANDS IN EXACTLY ONE GROUP. That is the property worth holding
 * on to, and the one whose absence hid a product from a paying customer. It is
 * asserted directly in `product-hub.spec.ts` rather than left to the reader.
 */
export function hubGroups(held: readonly ModuleKey[]): HubGroups {
  const heldKeys = new Set(held);
  return {
    yours: MODULE_KEYS.filter((key) => heldKeys.has(key) && MODULE_CATALOGUE[key].live),
    heldNotReady: MODULE_KEYS.filter((key) => heldKeys.has(key) && !MODULE_CATALOGUE[key].live),
    available: MODULE_KEYS.filter((key) => !heldKeys.has(key)),
  };
}

/**
 * The product to send somebody straight into, skipping the hub — or `null` to
 * show the hub.
 *
 * Founder-approved: a wall in front of somebody holding a single product is an
 * extra click every login, forever.
 *
 * ⚠️ AND ONLY INTO A PRODUCT THAT EXISTS. `moduleHref` resolves for every key
 * in the catalogue, built or not, so skipping on the COUNT alone would send
 * somebody holding one unbuilt product into a bare Next 404 — no shell, no way
 * back — as the first screen after signing in. Holding one unbuilt product
 * shows the hub instead, which can at least say what they are waiting for.
 */
export function hubSkipTarget(held: readonly ModuleKey[]): ModuleKey | null {
  if (held.length !== 1) return null;
  const only = held[0]!;
  return MODULE_CATALOGUE[only].live ? only : null;
}
