import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MODULE_CATALOGUE, MODULE_KEYS } from "@eva/types";
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
  organisation: { name: "Northgate Plumbing", initials: "NP", roleLabel: "Owner" },
  user: { name: "Sam Okafor", email: "sam.okafor@northgate.co.uk", initials: "SO" },
};

const render = (pathname: string, identity: SidebarIdentity = IDENTITY) =>
  renderToStaticMarkup(
    <SidebarBody pathname={pathname} identity={identity} signOutSlot={<span>sign out</span>} />,
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
  it("offers every section", () => {
    const html = render("/app");
    // ⚠️ FOUR, NOT FIVE. Settings left the nav on 2026-08-18 for the account
    // menu below — see the next test, which is where it is covered now.
    for (const label of ["Home", "Invoices", "Clients", "Chasing"]) {
      expect(html).toContain(label);
    }
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
    const html = render("/app/invoices");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    // The marked link is Invoices, not Home.
    expect(currentLink(html)).toContain('href="/app/invoices"');
  });

  it("marks Home only on Home itself", () => {
    expect(render("/app").match(/aria-current="page"/g)).toHaveLength(1);
    expect(currentLink(render("/app"))).toContain('href="/app"');
    expect(currentLink(render("/app/reminders"))).toContain('href="/app/reminders"');
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
    expect(html).toContain("Invoices");
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
});
