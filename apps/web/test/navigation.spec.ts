import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isActiveSection, showsAppChrome } from "@/lib/navigation";

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
      expect(isActiveSection("/app/settings/mailbox", "/app")).toBe(false);
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
