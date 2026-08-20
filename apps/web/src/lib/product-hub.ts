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

/**
 * The products somebody can switch on right now, from the hub itself.
 *
 * ⚠️ THIS IS THE FIRST-RUN SCREEN'S WHOLE JOB, AND IT WAS MISSING. Founder,
 * 2026-08-20: *"a page after get started or once user logs in or sign up where
 * they choose which feature they want… once they choose, they land at that
 * dashboard"*. The hub shipped in 3.0 routed people INTO products they already
 * held, which is the second visit. On the FIRST visit a customer holds nothing,
 * so the screen listed five products they could not click and pointed them at a
 * settings page to do the one thing they came to do.
 *
 * ⚠️ LIVE ONLY. The same rule as the sidebar and the skip: holding a product
 * must never outrank our having built it. Offering to switch on something with
 * no screens behind it is the 404 defect of 2026-08-19 wearing a button.
 */
export function startableProducts(held: readonly ModuleKey[]): readonly ModuleKey[] {
  return hubGroups(held).available.filter((key) => MODULE_CATALOGUE[key].live);
}

/**
 * Whether a key may be switched on from the hub at all.
 *
 * ⚠️ CHECKED IN THE SERVER ACTION, NOT ONLY IN THE SCREEN. The button is only
 * rendered for live products, but a form post is not a button — anybody can
 * send one. Hiding a control has never been enforcement in this codebase and is
 * not enforcement here.
 */
export function canStartProduct(moduleKey: string): moduleKey is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(moduleKey)
    ? MODULE_CATALOGUE[moduleKey as ModuleKey].live
    : false;
}
