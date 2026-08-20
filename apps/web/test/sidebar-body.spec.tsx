import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MODULE_CATALOGUE, MODULE_KEYS, moduleHref } from "@eva/types";
import { SidebarBody, type SidebarIdentity } from "@/app/app/sidebar-body";

/**
 * The shell, actually rendered (2026-08-09 design handoff).
 *
 * This is the first thing on every signed-in screen, and until the path became
 * a prop nothing could render it at all — `usePathname` made it unreachable
 * from a plain node test. `renderToStaticMarkup` needs no DOM and no new
 * dependency; the `ReminderStepList` precedent.
 */

const IDENTITY: SidebarIdentity = {
  organisationId: "11111111-1111-4111-8111-111111111111",
  organisation: { name: "Northgate Plumbing", initials: "NP", roleLabel: "Owner" },
  user: { name: "Sam Okafor", email: "sam.okafor@northgate.co.uk", initials: "SO" },
};

/** Everything built, and held — the ordinary paying customer. Exactly one
 *  product today, which is why the hub link is hidden by default. */
const HOLDS_EVERYTHING = MODULE_KEYS.filter((key) => MODULE_CATALOGUE[key].live);

/** A customer with a real choice — the only state in which the hub is useful. */
const HOLDS_TWO = [...HOLDS_EVERYTHING, "ai_receptionist"];

const render = (
  pathname: string,
  identity: SidebarIdentity = IDENTITY,
  heldModules: readonly string[] | null = HOLDS_EVERYTHING,
) =>
  renderToStaticMarkup(
    <SidebarBody
      pathname={pathname}
      identity={identity}
      heldModules={heldModules}
      signOutSlot={<span>sign out</span>}
    />,
  );

/**
 * The opening tag of the link marked as the current section.
 *
 * ⚠️ ATTRIBUTE ORDER IS REACT'S BUSINESS, NOT OURS. The first version of these
 * tests asserted `href=… aria-current=…` in that order and failed on markup
 * that was perfectly correct — a test that breaks when nothing is wrong gets
 * deleted by the next person, and takes its real coverage with it.
 */
const currentLink = (html: string): string =>
  html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";

describe("the sidebar, rendered", () => {
  /**
   * ⚠️ THE SECTIONS DEPEND ON WHERE YOU ARE (2026-08-19). One flat list held
   * Home, Invoices, Clients and Chasing — three of which belong to invoice
   * chasing — so a customer who bought only a lead product would have been
   * offered three dead ends. Inside a product you get that product's screens
   * plus the platform's; on a platform screen you get the platform's only.
   */
  it("offers the platform's sections everywhere", () => {
    // Two products, so the hub is a real destination rather than a bounce.
    const html = render("/app", IDENTITY, HOLDS_TWO);
    for (const label of ["All products", "Clients"]) expect(html).toContain(label);
  });

  it("offers a product's own sections while inside it", () => {
    const html = render("/app/invoice-chasing");
    for (const label of ["Home", "Invoices", "Chasing", "Clients"]) {
      expect(html).toContain(label);
    }
  });

  /**
   * ⚠️ REVERSED ON 2026-08-20, AND THE WAY OUT MATTERS MORE THAN THE TIDINESS.
   *
   * This used to assert the OPPOSITE: "All products" was hidden for a customer
   * holding one product, because `/app` sent them straight back into that
   * product and a link that changes nothing reads as broken. The founder
   * removed that skip — everybody lands on the hub now — so the link goes
   * somewhere real for everyone.
   *
   * ⚠️ THIS IS THE HALF THAT WOULD HAVE BEEN MISSED. Deleting the skip in
   * `app/page.tsx` and leaving the sidebar alone would have stranded a
   * one-product customer inside their product with no way back to the screen
   * the founder asked to be able to reach — two halves of one promise in two
   * files, with nothing failing in between. Found by reading the sidebar after
   * changing the page, not by a test.
   */
  it("always offers 'All products', however many the customer holds", () => {
    expect(render("/app/invoice-chasing", IDENTITY, ["email_credit_controller"])).toContain(
      "All products",
    );
    expect(render("/app", IDENTITY, HOLDS_TWO)).toContain("All products");
    expect(render("/app", IDENTITY, [])).toContain("All products");
    expect(render("/app", IDENTITY, null)).toContain("All products");
  });

  it("does NOT offer a product's sections from a platform screen", () => {
    const html = render("/app/clients");
    // The invoice book belongs to invoice chasing; from Clients it is not a
    // section, and offering it would be the dead end this split removes.
    expect(html).not.toContain('href="/app/invoice-chasing/invoices"');
  });

  /**
   * ⚠️ THE ACCOUNT MENU IS THE ONLY DOOR TO TWO SCREENS. Settings and
   * `/change-password` are reachable from nowhere else in the signed-in app —
   * the padlock icon that used to carry the second one was removed when they
   * were gathered under the user's name (founder, 2026-08-18). Both routes
   * would still exist, still pass their own tests, and be unreachable by anyone
   * not typing a URL.
   *
   * Rendered even while shut, which is what makes it visible to a static test —
   * `UserMenu` hides it with a class rather than dropping it from the markup,
   * and says so.
   */
  it("puts Settings, the password and sign-out under the user's own name", () => {
    const html = render("/app");
    expect(html).toContain('href="/app/settings/reminders"');
    expect(html).toContain('href="/change-password"');
    expect(html).toContain("sign out");
    // The trigger is the user's card, and it says what it does.
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Sam Okafor");
  });

  /**
   * ⚠️ THE BUG THIS SHAPE INVITES, AND THE ONE SLICE 1.9 ALREADY FIXED ONCE.
   * Every path in the product begins `/app`, so a plain `startsWith` marks Home
   * as the current section on every screen — a nav that is always "here" tells
   * you nothing about where you are. Asserted through the RENDER, not just the
   * rule, because the rule was already right and the wiring is what is new.
   */
  it("marks exactly one section as current, and the right one", () => {
    const html = render("/app/invoice-chasing/invoices");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    // The marked link is Invoices, not the product's Home — which is now a
    // PREFIX of this path, so a careless `startsWith` lights the wrong one.
    expect(currentLink(html)).toContain('href="/app/invoice-chasing/invoices"');
  });

  it("marks the hub only on the hub itself", () => {
    expect(render("/app", IDENTITY, HOLDS_TWO).match(/aria-current="page"/g)).toHaveLength(1);
    expect(currentLink(render("/app", IDENTITY, HOLDS_TWO))).toContain('href="/app"');
    expect(currentLink(render("/app/invoice-chasing/chasing"))).toContain(
      'href="/app/invoice-chasing/chasing"',
    );
    /**
     * ⚠️ NOTHING IS CURRENT ON A SETTINGS SCREEN, and that is the state after
     * 2026-08-18 rather than a gap: settings is no longer a section of the nav.
     * The half that still matters is the half that was the original bug — a
     * careless `startsWith` would light HOME here, on a path that belongs to no
     * section at all, which is precisely where it would be least noticed.
     */
    expect(render("/app/settings/reminders")).not.toContain('aria-current="page"');
  });

  it("names the organisation and the role you hold in it", () => {
    const html = render("/app");
    expect(html).toContain("Northgate Plumbing");
    expect(html).toContain("Owner");
    expect(html).toContain("NP");
  });

  /**
   * ⚠️ A BRAND-NEW ACCOUNT HAS NO ORGANISATION, and the chip must be absent
   * rather than empty. An initials disc with nothing in it reads as a rendering
   * fault at the top of every screen. The same branch covers "the fetch
   * failed", which is why the layout swallows its own errors.
   */
  it("leaves the organisation chip out entirely when there is none", () => {
    const html = render("/app", { ...IDENTITY, organisation: null });
    expect(html).not.toContain("Northgate Plumbing");
    expect(html).not.toContain("Owner");
    // The rest of the shell still renders — no organisation is not no app.
    // Checked against a PLATFORM section: "Invoices" belongs to a product and
    // is legitimately absent from `/app` since the hub landed.
    expect(html).toContain("Clients");
    expect(html).toContain("Sam Okafor");
  });

  it("shows who is signed in, so the account is never a guess", () => {
    const html = render("/app");
    expect(html).toContain("Sam Okafor");
    expect(html).toContain("sam.okafor@northgate.co.uk");
    expect(html).toContain("SO");
  });

  /**
   * Naming what is coming is honest; hiding it would make the product look
   * finished. The live one must be distinguishable from the ones that are not.
   */
  it("names the modules that are not built yet as 'soon'", () => {
    const html = render("/app");
    expect(html).toContain("Invoice Chasing");
    expect(html.match(/soon/g)).toHaveLength(
      MODULE_KEYS.filter((key) => !MODULE_CATALOGUE[key].live).length,
    );
  });

  /**
   * ⚠️ THE GUARD FOR THE DEFECT, NOT THE DEFECT (found by walking, 2026-08-18).
   *
   * This list was hand-written here and it had drifted from the settings screen
   * in every way a list can: it was missing Voice Credit Control entirely, and
   * it called the other two by different names than settings did. Nothing could
   * fail, because no test could see both files at once.
   *
   * Fixing the list would have fixed today. Asserting the sidebar shows the
   * WHOLE catalogue, under the catalogue's OWN names, is what stops the next
   * product being added to one screen and not the other.
   */
  it("shows every product in the catalogue, under the catalogue's name", () => {
    const html = render("/app");
    for (const key of MODULE_KEYS) {
      expect(html).toContain(MODULE_CATALOGUE[key].name);
    }
  });

  /**
   * ⚠️ THE GUARD FOR A DEFECT FOUND BY WALKING, 2026-08-19.
   *
   * The dot was rendered from `MODULE_CATALOGUE[key].live` — "we have built
   * this" — and never asked what the organisation actually holds. So with
   * Invoice Chasing switched OFF, the sidebar showed it lit while
   * `/app/invoices` said "…doesn't have Invoice Chasing". One screen, two
   * statements: the money-bug family.
   *
   * Three states, three sentences, and the test asserts all three because the
   * dangerous one is the middle: "built but not bought" used to be
   * indistinguishable from "running".
   */
  it("marks a built product the organisation does NOT hold as off, not live", () => {
    const html = render("/app", IDENTITY, []);
    // Every built product is off, so there is one "off" badge per built product.
    expect(html.match(/>off</g) ?? []).toHaveLength(HOLDS_EVERYTHING.length);
    // ...and no live dot anywhere.
    expect(html).not.toContain("bg-module-live");
  });

  it("marks a product the organisation DOES hold as live", () => {
    const html = render("/app", IDENTITY, HOLDS_EVERYTHING);
    expect(html).toContain("bg-module-live");
    expect(html).not.toContain(">off<");
  });

  /**
   * ⚠️ THE GUARD FOR A 404 THAT REACHED PRODUCTION (walked 2026-08-19).
   *
   * There is a FOURTH state — held AND not built — and this branch asked
   * `held === true` alone, so holding a product outranked our having built it.
   * The founder's organisation holds `voice_credit_controller` (a row from
   * before the phantom-products fix, when the screen still offered unbuilt
   * products), so the sidebar rendered a live dot linking to
   * `/app/voice-credit-control`. That is not a route: a bare Next 404, no
   * shell, no way back — while the Products screen on the same page load
   * called the same product "Coming soon".
   *
   * The assertion is on the HREF, not the dot, because the href is the part
   * that took somebody nowhere.
   */
  it("does not offer a way into a product it holds but we have not built", () => {
    const unbuilt = MODULE_KEYS.filter((key) => !MODULE_CATALOGUE[key].live);
    // Holds everything in the catalogue — including the products that do not exist yet.
    const html = render("/app", IDENTITY, MODULE_KEYS);

    for (const key of unbuilt) {
      expect(html).not.toContain(`href="${moduleHref(key)}"`);
      // Still named, and still honest about why there is nowhere to go.
      expect(html).toContain(MODULE_CATALOGUE[key].name);
    }
    // Every unbuilt product still carries "soon" — holding one changes nothing.
    expect(html.match(/soon/g) ?? []).toHaveLength(unbuilt.length);
    // ...and the one product that IS built and held is still reachable.
    expect(html).toContain(`href="${moduleHref("email_credit_controller")}"`);
  });

  /**
   * ⚠️ UNKNOWN IS NOT "OWNS NOTHING". The shell swallows its own fetch
   * failures, so a modules call that fails arrives here as `null`. Rendering
   * that as "off" would replace one confident lie with another — this time
   * telling a paying customer they do not have what they pay for.
   */
  it("claims nothing when it could not find out what the organisation holds", () => {
    const html = render("/app", IDENTITY, null);
    expect(html).not.toContain("bg-module-live");
    expect(html).not.toContain(">off<");
    // The products are still named — hiding them would be a third wrong answer.
    for (const key of MODULE_KEYS) expect(html).toContain(MODULE_CATALOGUE[key].name);
  });
});
