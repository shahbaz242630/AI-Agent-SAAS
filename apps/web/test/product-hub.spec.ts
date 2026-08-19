import { describe, expect, it } from "vitest";
import { MODULE_CATALOGUE, MODULE_KEYS, type ModuleKey } from "@eva/types";
import { hubGroups, hubSkipTarget } from "@/lib/product-hub";

/**
 * ⚠️ THE GUARD FOR TWO DEFECTS THAT REACHED PRODUCTION (walked 2026-08-19,
 * minutes after the deploy that carried the hub).
 *
 * The founder's organisation holds `voice_credit_controller` — a row from
 * before the phantom-products fix, when the screen still offered products we
 * had not built. On production that produced:
 *
 *   1. a product they HOLD appearing NOWHERE on the hub, because the two lists
 *      were "live AND held" and "NOT held" and it was in neither; while
 *   2. the sidebar showed it lit and linked it to `/app/voice-credit-control`,
 *      a bare Next 404 with no shell and no way back.
 *
 * The hub itself is an async server component that redirects and fetches, so
 * none of this was reachable by a test. That is why the rules moved into
 * `lib/product-hub.ts` — the defect was invisible because the code was.
 */

const BUILT = MODULE_KEYS.filter((key) => MODULE_CATALOGUE[key].live);
const UNBUILT = MODULE_KEYS.filter((key) => !MODULE_CATALOGUE[key].live);

describe("the hub's grouping", () => {
  it("has something to test with (a guard over an empty catalogue proves nothing)", () => {
    expect(BUILT.length).toBeGreaterThan(0);
    expect(UNBUILT.length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ THIS IS THE PROPERTY WHOSE ABSENCE HID A PRODUCT FROM A PAYING CUSTOMER.
   * Not "the groups look right" — every key in the catalogue lands in exactly
   * one group, whatever the organisation holds. A product that falls through
   * every list is invisible, and invisible is the one thing a screen about what
   * you are paying for must never be.
   */
  it("puts every product in exactly one group, for every combination", () => {
    const combinations: readonly ModuleKey[][] = [
      [],
      [...BUILT],
      [...UNBUILT],
      [...MODULE_KEYS],
      [BUILT[0]!, UNBUILT[0]!],
      [UNBUILT[0]!],
    ];

    for (const held of combinations) {
      const { yours, heldNotReady, available } = hubGroups(held);
      const all = [...yours, ...heldNotReady, ...available];
      expect(new Set(all).size).toBe(MODULE_KEYS.length);
      expect(all).toHaveLength(MODULE_KEYS.length);
    }
  });

  it("offers a way in only to products that are both held and built", () => {
    const { yours, heldNotReady } = hubGroups(MODULE_KEYS);
    expect(yours).toEqual(BUILT);
    // Held, but there is nowhere to send them — so it is named, not linked.
    expect(heldNotReady).toEqual(UNBUILT);
  });

  it("keeps a product the organisation holds but we have not built", () => {
    const held = [UNBUILT[0]!];
    const { yours, heldNotReady, available } = hubGroups(held);
    expect(yours).toHaveLength(0);
    expect(heldNotReady).toEqual(held);
    // ...and it is NOT offered as something to switch on: they already have it.
    expect(available).not.toContain(UNBUILT[0]!);
  });
});

describe("the hub's skip", () => {
  /**
   * Founder-approved: a wall in front of somebody holding a single product is
   * an extra click every login, forever.
   */
  it("sends a customer holding one built product straight into it", () => {
    expect(hubSkipTarget([BUILT[0]!])).toBe(BUILT[0]!);
  });

  /**
   * ⚠️ THE 404 TRAP. `moduleHref` resolves for every key in the catalogue,
   * built or not, so skipping on the COUNT alone would have redirected
   * somebody holding one unbuilt product into a page that does not exist — as
   * the first thing they saw after signing in, with no shell to escape from.
   */
  it("does NOT skip into a product that does not exist yet", () => {
    expect(hubSkipTarget([UNBUILT[0]!])).toBeNull();
  });

  it("shows the hub when there is a real choice, or nothing at all", () => {
    expect(hubSkipTarget([])).toBeNull();
    expect(hubSkipTarget([BUILT[0]!, UNBUILT[0]!])).toBeNull();
    expect(hubSkipTarget([...MODULE_KEYS])).toBeNull();
  });
});
