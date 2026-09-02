import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ATTRIBUTED_APP_SECTIONS, ownerForRoute, UNATTRIBUTED } from "../src/lib/product-owner.js";

/**
 * The web half of per-product attribution (Slice 3.0c).
 *
 * ⚠️ THE API'S WALL CANNOT SEE THIS ONE. There, the owner is derived from the
 * controller's folder and checked against it; a Next route has no controller,
 * so the map is written by hand and the only thing standing between it and rot
 * is this file. Same lesson as the web having no `pnpm boundaries` config until
 * 2026-08-19: the rule that exists on one side and not the other is the side
 * that breaks.
 */

const WEB_SRC = path.resolve(__dirname, "../src");
const APP_ROUTES = path.join(WEB_SRC, "app", "app");

/** Route folders directly under `/app` — the sections a customer navigates. */
function routeSections(): string[] {
  return (
    readdirSync(APP_ROUTES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // Route groups `(auth)` and private folders `_x` are not URL segments.
      .filter((entry) => !entry.name.startsWith("(") && !entry.name.startsWith("_"))
      .map((entry) => entry.name)
  );
}

describe("Every route under /app is attributed to something", () => {
  it("finds the route folders at all", () => {
    expect(routeSections().length).toBeGreaterThanOrEqual(5);
  });

  /**
   * ⚠️ THE ONE THAT FIRES WHEN LEAD FOLLOW-UP LANDS. Its screens will arrive as
   * a new folder under `app/app/`, and without this the whole product would log
   * as nobody's — silently, and only noticed the first time a customer of it
   * complained.
   */
  it("names every route folder, so a new product cannot log as nobody's", () => {
    const unattributed = routeSections().filter(
      (section) => !ATTRIBUTED_APP_SECTIONS.includes(section),
    );

    expect(
      unattributed,
      `add these to APP_SECTIONS in lib/product-owner.ts: ${unattributed.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * ⚠️ THE EXAMPLE HERE MUST BE A ROUTE THAT CAN NEVER BECOME REAL, AND THE
   * ORIGINAL WAS NOT. It used `/app/lead-follow-up` — an invented route at the
   * time, because the lead product's screens lived at `/app/lead-follow-up-email`.
   * Slice 3.2a renamed the product and that URL became one of ours, which
   * turned this test's NEGATIVE case into a positive one. It went red, which is
   * the guard working; had it been asserting the other direction it would have
   * gone quietly green and stopped testing anything.
   *
   * `internal-diagnostics` is not a product, not a slug in `MODULE_CATALOGUE`,
   * and not a word this business would ship to a customer.
   */
  it("attributes nothing it was not told about", () => {
    expect(ownerForRoute("/app/internal-diagnostics")).toBe(UNATTRIBUTED);
  });
});

describe("ownerForRoute", () => {
  it("puts the invoice product's own screens on the invoice product", () => {
    expect(ownerForRoute("/app/invoice-chasing")).toBe("product:invoice-follow-up");
    expect(ownerForRoute("/app/invoice-chasing/invoices/import")).toBe("product:invoice-follow-up");
  });

  /** ⚠️ THE TAG NAMES THE CODE FOLDER, NOT THE URL. `invoice-chasing` is what
   *  the customer sees; `invoice-follow-up` is where the code lives, on both
   *  sides of the wire. One search has to find both. */
  it("uses the folder name, not the customer-facing slug", () => {
    expect(ownerForRoute("/app/invoice-chasing")).not.toContain("invoice-chasing");
  });

  it("keeps the hub, clients and settings on the platform", () => {
    expect(ownerForRoute("/app")).toBe("platform");
    expect(ownerForRoute("/app/clients")).toBe("platform");
    expect(ownerForRoute("/app/settings/invoices")).toBe("platform");
    expect(ownerForRoute("/app/onboarding")).toBe("platform");
  });

  /**
   * ⚠️ THE TWO DECLARED CROSSINGS. Platform URLs rendering the invoice
   * product's screens. Filing their failures under `platform` would hide a
   * product's own defects from the search built to find them.
   */
  it("files the two platform routes that render invoice screens under the product", () => {
    expect(ownerForRoute("/app/clients/[customerId]/invoices")).toBe("product:invoice-follow-up");
    expect(ownerForRoute("/app/settings/reminders")).toBe("product:invoice-follow-up");
  });

  it("leaves the client's own page on the platform — only its invoices cross", () => {
    expect(ownerForRoute("/app/clients/[customerId]")).toBe("platform");
  });

  it("puts the Microsoft consent landing page on the mailbox capability", () => {
    expect(ownerForRoute("/microsoft-approved")).toBe("capability:mailbox");
  });

  /**
   * ⚠️ ONE COMPONENT, TWO DOORS, ONE OWNER. Both products render the same
   * `MailboxScreen`. Tagged by URL, a single defect in it would be filed under
   * whichever product the customer happened to be in — the same bug under two
   * owners, and neither search finding both.
   */
  it("files both products' mailbox screens under the mailbox capability", () => {
    expect(ownerForRoute("/app/invoice-chasing/mailbox")).toBe("capability:mailbox");
    expect(ownerForRoute("/app/lead-follow-up/mailbox")).toBe("capability:mailbox");
    // ...and the product's own screens are still the product's.
    expect(ownerForRoute("/app/invoice-chasing/invoices")).toBe("product:invoice-follow-up");
  });

  it("treats sign-in and the front door as platform", () => {
    expect(ownerForRoute("/sign-in")).toBe("platform");
    expect(ownerForRoute("/")).toBe("platform");
    expect(ownerForRoute("/auth/confirm")).toBe("platform");
  });

  it("ignores a query string", () => {
    expect(ownerForRoute("/app/invoice-chasing?tab=due")).toBe("product:invoice-follow-up");
  });

  /** `/app/invoice-chasing-notes` must not be read as the invoice product. */
  it("matches whole segments, not string prefixes", () => {
    expect(ownerForRoute("/app/invoice-chasing-notes")).toBe(UNATTRIBUTED);
  });
});

/**
 * ⚠️ THE TWO APPS MUST CALL A PRODUCT THE SAME THING, or one Sentry filter
 * finds half of it. The API tags from `apps/api/src/products/<folder>` and the
 * web tags from this map; nothing else compares the two, and the day they
 * diverge every search silently returns half an answer.
 */
/**
 * ⚠️ A PRODUCT MAY LEGITIMATELY EXIST ON ONE SIDE ONLY, AND SLICE 3.1a IS THE
 * FIRST CASE. This test used to demand identical sets, which is a stricter
 * thing than the rule above actually needs — the rule is that the two apps must
 * NAME a product the same, not that both must have reached it yet.
 *
 * `lead-follow-up` has web screens and no API folder, and that is the founder's
 * own ruling rather than an oversight: the lead RECORD is PLATFORM, because
 * three products will want the same lead and a person must not become three
 * records with do-not-contact honoured on one of them. So the API's lead code
 * sits in `platform/leads`. The product's own API code arrives at 3.1b, when
 * Eva reads a mailbox — machinery that is genuinely this product's and nobody
 * else's.
 *
 * ⚠️ NOTHING GOES ON THIS LIST WITHOUT A REASON WRITTEN BESIDE IT — the same
 * rule `ALLOWED_CROSSINGS` carries in the API, for the same reason: an
 * exception list that grows silently is how a boundary dies politely.
 */
/**
 * ⚠️ EMPTY SINCE 3.1c-1, AND THAT IS THE GOOD STATE. It held `lead-follow-up`
 * with the reason "the API's lead record is platform until this product has API
 * code of its own" — which expired the moment slice 3.1c-1 gave it
 * `products/lead-follow-up/`, its manifest and the templates it owns.
 *
 * ⚠️ AND THE FOLDER HAS NOW BEEN NAMED BOTH THINGS, WHICH IS WORTH READING
 * BEFORE RENAMING IT A THIRD TIME. Slice 3.1c-1 renamed it `lead-follow-up` →
 * `lead-follow-up-email`, on the reasoning that ruling 14 makes Lead Follow-up
 * by CALL a separate product, so the bare name was ambiguous. Slice 3.2a
 * renamed it back, because founder ruling 62 folded WhatsApp, Messenger and
 * Instagram into the same product — so the thing that distinguishes it from the
 * call product is no longer email, and naming it after one of its four channels
 * was the more misleading of the two options.
 *
 * Both renames were right on the day. This test is what caught the first one
 * being done on one side only.
 */
const ONE_SIDED: Record<string, string> = {};

describe("The API and the web agree on what a product is called", () => {
  const folders = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

  const web = folders(path.join(WEB_SRC, "products"));
  const api = folders(path.resolve(__dirname, "../../api/src/products"));

  /**
   * The teeth. A folder on one side only is either declared above with its
   * reason, or it is the divergence this file exists to catch — including the
   * one that matters most, a rename on one side (`lead-followup` against
   * `lead-follow-up`), which shows up here as TWO undeclared one-sided folders.
   */
  /**
   * ⚠️ THE RULE ABOVE WAS STATED AND NOT CHECKED, AND IT COST A DAY.
   *
   * This file's own header says the two apps must call a product the same
   * thing "or one Sentry filter finds half of it" — and then compared only the
   * two directory listings. The API derives its tag FROM its folder
   * (`@OwnedBy("product:lead-follow-up")`, enforced by
   * `product-attribution.spec.ts`); the web hand-writes it in
   * `product-owner.ts`. When #130 renamed the web folder, the hand-written tag
   * stayed on the old name, the two apps filed one product under two names,
   * and every wall stayed green.
   *
   * So: every `product:` tag the web uses must name a real API product folder.
   * A rename on either side now fails here.
   */
  it("tags products by a name the API also uses", () => {
    const source = readFileSync(path.join(WEB_SRC, "lib/product-owner.ts"), "utf8");
    const tagged = [...source.matchAll(/"product:([a-z0-9-]+)"/g)].map((m) => m[1]!);

    // A scan that found nothing would pass this whole test silently.
    expect(new Set(tagged).size, "no product tags found — the scanner is broken").toBeGreaterThan(
      0,
    );

    const unknown = [...new Set(tagged)].filter((folder) => !api.includes(folder)).sort();
    expect(
      unknown,
      "these web owner tags name no API product folder — rename one side or the other",
    ).toEqual([]);
  });

  it("never has a product folder on one side that nobody has explained", () => {
    const shared = new Set(web.filter((folder) => api.includes(folder)));
    const oneSided = [...new Set([...web, ...api])].filter((f) => !shared.has(f)).sort();

    expect(oneSided, "add these to ONE_SIDED with a reason, or fix the name").toEqual(
      Object.keys(ONE_SIDED).sort(),
    );
  });

  /**
   * ⚠️ AND THE LIST MUST NOT OUTLIVE ITS REASON. A product declared one-sided
   * that has since grown a folder on both sides should come OFF the list, or
   * the next real divergence is masked by a stale entry.
   */
  it("drops a product from the list once both sides have it", () => {
    for (const folder of Object.keys(ONE_SIDED)) {
      const onBoth = web.includes(folder) && api.includes(folder);
      expect(onBoth, `${folder} is on both sides now — remove it from ONE_SIDED`).toBe(false);
    }
  });
});
