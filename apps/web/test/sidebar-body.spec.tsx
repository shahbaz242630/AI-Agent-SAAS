import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    for (const label of ["Home", "Invoices", "Clients", "Chasing", "Settings"]) {
      expect(html).toContain(label);
    }
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
    // A deeper settings path still lights Settings, not Home.
    expect(currentLink(render("/app/settings/reminders"))).toContain(
      'href="/app/settings/reminders"',
    );
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
   * finished. The live one must be distinguishable from the two that are not.
   */
  it("names the modules that are not built yet as 'soon'", () => {
    const html = render("/app");
    expect(html).toContain("Invoice Chasing");
    expect(html.match(/soon/g)).toHaveLength(2);
  });
});
