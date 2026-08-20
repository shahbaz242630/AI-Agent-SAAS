import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_CATALOGUE, MODULE_KEYS, type ModuleKey } from "@eva/types";
import { canStartProduct, hubGroups, startableProducts } from "@/lib/product-hub";

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

/**
 * ⚠️ THE HUB IS ALWAYS SHOWN — THE SKIP IS GONE, AND MUST NOT COME BACK.
 *
 * Holding one built product used to redirect straight into it. The founder
 * approved that reasoning, used it, and overruled it on 2026-08-20: *"I signed
 * in .. still land on invoice chasing dashboard .. I should land on page which
 * shows all options so I can select which dashboard to check"*.
 *
 * This test reads the page's own source, the same technique the API uses to
 * check every controller declares an owner. It is here because the argument for
 * the skip is still written down in the archive and reads persuasively — a
 * future session tidying up "an extra click every login" would restore the
 * exact behaviour the founder rejected, and no other test would notice.
 */
describe("the hub never redirects into a product", () => {
  it("has no redirect into a product route in the hub page", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/app/app/page.tsx"), "utf8");

    // `redirect("/sign-in")` and `redirect("/app/onboarding")` are fine and
    // expected — they are not products. A redirect built from `moduleHref` is
    // the skip, whatever it gets called next time.
    expect(source, "the hub is redirecting into a product again").not.toMatch(
      /redirect\(\s*moduleHref/,
    );
  });

  it("keeps a single held product on the hub as a card you click", () => {
    const { yours } = hubGroups([BUILT[0]!]);

    expect(yours).toEqual([BUILT[0]!]);
  });
});

/**
 * The first-run choice (2026-08-20).
 *
 * ⚠️ THE HUB SHIPPED IN 3.0 SOLVED THE SECOND VISIT, NOT THE FIRST. It routed
 * people into products they already held. Somebody who has just signed up holds
 * nothing, so the screen listed five products they could not click and pointed
 * them at a settings page to do the one thing they came for. Founder,
 * 2026-08-20: *"a page where they choose which feature they want… once they
 * choose they land at that dashboard"*.
 */
describe("startableProducts", () => {
  it("offers a product we have built and they do not hold", () => {
    expect(startableProducts([])).toContain("email_credit_controller");
  });

  /** ⚠️ THE 2026-08-19 DEFECT, WEARING A BUTTON. Offering to switch on a
   *  product with no screens behind it lands the customer in a bare 404 — the
   *  thing PR #90 closed. Holding a product must never outrank building it. */
  it("never offers a product we have not built", () => {
    for (const key of startableProducts([])) {
      expect(MODULE_CATALOGUE[key].live, `${key} is offered but is not built`).toBe(true);
    }
  });

  it("does not offer something they already hold", () => {
    expect(startableProducts(["email_credit_controller"])).not.toContain("email_credit_controller");
  });

  /** Every startable key is one the hub is already showing, so a button can
   *  never appear beside a product the screen has not listed. */
  it("only ever offers keys from the available group", () => {
    const held: ModuleKey[] = ["voice_credit_controller"];
    const { available } = hubGroups(held);
    for (const key of startableProducts(held)) {
      expect(available).toContain(key);
    }
  });
});

describe("canStartProduct", () => {
  it("allows a real, built product", () => {
    expect(canStartProduct("email_credit_controller")).toBe(true);
  });

  /**
   * ⚠️ THE SCREEN IS NOT THE ENFORCEMENT. The button renders only for live
   * products, but a form post is not a button — anybody can send one. Hiding a
   * control has never been enforcement in this codebase.
   */
  it("refuses a real product we have not built yet", () => {
    expect(canStartProduct("lead_follow_up_email")).toBe(false);
  });

  it("refuses a key that is not a product at all", () => {
    expect(canStartProduct("email_credit_controller; drop table")).toBe(false);
    expect(canStartProduct("")).toBe(false);
  });

  /** The rule that keeps the two in step: anything the screen offers, the
   *  action must accept, and nothing else. */
  it("accepts exactly what the hub offers", () => {
    for (const key of MODULE_KEYS) {
      expect(canStartProduct(key)).toBe(startableProducts([]).includes(key));
    }
  });
});
