import { describe, expect, it } from "vitest";
import {
  NAV_ITEMS,
  PRODUCT_NAV,
  isActiveSection,
  isChooserPath,
  showsAppChrome,
  showsChooserHeader,
  showsSidebar,
} from "@/lib/navigation";
import { NAV_ICONS } from "@/app/app/nav-icons";

/**
 * The app shell's navigation (Slice 1.9).
 *
 * The active-section rule is the whole reason this logic lives in a lib: the
 * obvious `pathname.startsWith(href)` marks **Home** active on every screen in
 * the product, because every path begins with `/app`. A nav that always says
 * "you are here" tells you nothing.
 */
describe("app navigation", () => {
  describe("the items themselves", () => {
    it("gives every item a label, a description and a unique href", () => {
      const hrefs = NAV_ITEMS.map((item) => item.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
      for (const item of NAV_ITEMS) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
        expect(item.href.startsWith("/app")).toBe(true);
      }
    });

    it("starts at Home", () => {
      expect(NAV_ITEMS[0]?.href).toBe("/app");
    });
  });

  describe("which section is active", () => {
    /**
     * ⚠️ THE MUTATION TARGET. Drop the exact-match branch for `/app` and this is
     * the test that goes red — every other assertion here still passes, because
     * they all check paths that legitimately begin with their own section.
     */
    it("never marks Home active on another section's screen", () => {
      for (const item of NAV_ITEMS) {
        if (item.href === "/app") continue;
        expect(isActiveSection(item.href, "/app")).toBe(false);
      }
      expect(isActiveSection("/app/invoices/import", "/app")).toBe(false);
      expect(isActiveSection("/app/settings/reminders", "/app")).toBe(false);
    });

    it("marks Home active only on Home itself", () => {
      expect(isActiveSection("/app", "/app")).toBe(true);
      expect(isActiveSection("/app/", "/app")).toBe(true);
    });

    it("marks a section active on its own nested screens", () => {
      expect(isActiveSection("/app/invoices", "/app/invoices")).toBe(true);
      expect(isActiveSection("/app/invoices/import", "/app/invoices")).toBe(true);
      expect(isActiveSection("/app/invoices/import/abc-123", "/app/invoices")).toBe(true);
      expect(isActiveSection("/app/clients/9/invoices", "/app/clients")).toBe(true);
    });

    /**
     * A prefix has to end at a segment boundary, or a future `/app/invoices-archive`
     * would light up the Invoices tab while showing something else entirely.
     */
    it("does not treat a longer word as the same section", () => {
      expect(isActiveSection("/app/invoices-archive", "/app/invoices")).toBe(false);
    });

    it("keeps exactly one nav item active on every screen a nav item points at", () => {
      for (const screen of NAV_ITEMS) {
        const active = NAV_ITEMS.filter((item) => isActiveSection(screen.href, item.href));
        expect(active).toHaveLength(1);
        expect(active[0]?.href).toBe(screen.href);
      }
    });
  });

  describe("where the shell is hidden", () => {
    /**
     * Onboarding is a flow, not a destination: a brand-new account has no
     * organisation, so every nav link would land on "create an organisation
     * first" — a menu of dead ends at the moment someone needs one instruction.
     */
    it("hides the shell during onboarding and organisation creation", () => {
      expect(showsAppChrome("/app/onboarding")).toBe(false);
      expect(showsAppChrome("/app/onboarding/step-2")).toBe(false);
      expect(showsAppChrome("/app/organisations/new")).toBe(false);
    });

    it("shows the shell on every screen a nav item points at", () => {
      for (const item of NAV_ITEMS) {
        expect(showsAppChrome(item.href)).toBe(true);
      }
      expect(showsAppChrome("/app/invoices/import")).toBe(true);
    });
  });
});

describe("the chooser has its own chrome (founder, 2026-08-20)", () => {
  /**
   * ⚠️ THE PROPERTY, NOT THE CASES. Settings, Change password and Sign out live
   * in the sidebar's account menu on every workspace screen and in the
   * chooser's top bar on `/app`. If a signed-in path could ever show NEITHER,
   * those three would be unreachable from it — `user-menu.tsx` says it is the
   * only route to two of them, and that stops being a warning and becomes a
   * trap once the sidebar is gone from a page.
   *
   * Asserted over every path the app can be on rather than the two we happened
   * to think of.
   */
  it("shows exactly one of the sidebar and the chooser bar, on every path", () => {
    const paths = [
      "/app",
      "/app/",
      "/app/clients",
      "/app/clients/abc/invoices",
      "/app/invoice-chasing",
      "/app/invoice-chasing/invoices/import",
      "/app/invoice-chasing/mailbox",
      "/app/lead-follow-up/mailbox",
      "/app/settings/reminders",
      ...NAV_ITEMS.map((item) => item.href),
    ];

    for (const path of paths) {
      const both = [showsSidebar(path), showsChooserHeader(path)].filter(Boolean).length;
      expect(both, `${path} shows ${both} of the two account menus, not 1`).toBe(1);
    }
  });

  /** Onboarding is the one place that legitimately shows neither — there is no
   *  account menu to reach because there is not yet an account to manage. */
  it("shows neither during onboarding, which is the whole point of that flow", () => {
    for (const path of ["/app/onboarding", "/app/organisations/new"]) {
      expect(showsSidebar(path)).toBe(false);
      expect(showsChooserHeader(path)).toBe(false);
    }
  });

  it("treats only /app itself as the chooser", () => {
    expect(isChooserPath("/app")).toBe(true);
    expect(isChooserPath("/app/")).toBe(true);
    expect(isChooserPath("/app/clients")).toBe(false);
    expect(isChooserPath("/app/invoice-chasing")).toBe(false);
  });

  it("keeps the sidebar off the chooser and on everything else", () => {
    expect(showsSidebar("/app")).toBe(false);
    expect(showsSidebar("/app/clients")).toBe(true);
    expect(showsSidebar("/app/invoice-chasing")).toBe(true);
  });
});

/**
 * ⚠️ EVERY NAV ITEM MUST HAVE AN ICON, AND THIS GUARD EXISTS BECAUSE THE GAP
 * HAS NOW OPENED TWICE IN TWO DAYS.
 *
 * `NAV_ICONS` is keyed by href, and `sidebar-body.tsx` renders nothing at all
 * when a key is missing — "a missing key renders no icon rather than throwing",
 * which is safe in the sense that nothing crashes and unsafe in the sense that
 * nobody finds out. On 2026-08-19 the products got their own URLs and the keys
 * stayed on the old ones, so Invoices and Chasing lost their icons for five
 * weeks. On 2026-08-20 the lead product shipped its screens and its nav item
 * arrived with no key at all — the same hole, one day after fixing it, found by
 * looking at production rather than by anything failing.
 *
 * An icon is not decoration here: without one the label starts where no other
 * label starts, so the row reads as broken rather than as plain.
 */
describe("every nav item is illustrated", () => {
  const everyItem = [...NAV_ITEMS, ...Object.values(PRODUCT_NAV).flatMap((items) => items ?? [])];

  it("has an icon for each item, in both the platform nav and every product's", () => {
    const missing = everyItem
      .filter((item) => !NAV_ICONS[item.href])
      .map((item) => `${item.label} (${item.href})`);

    expect(missing, "add a key to NAV_ICONS for these").toEqual([]);
  });

  /** The foundation: if the lists ever come back empty the test above passes
   *  while proving nothing, which is the failure mode it was written against. */
  it("is looking at a nav that actually has items in it", () => {
    expect(everyItem.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(PRODUCT_NAV).length).toBeGreaterThanOrEqual(2);
  });
});
