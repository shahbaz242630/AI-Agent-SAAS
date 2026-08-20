import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACCOUNT_MENU_ITEMS } from "@/lib/navigation";
import { ChooserHeaderBody } from "@/app/app/chooser-header-body";
import type { SidebarIdentity } from "@/app/app/sidebar-body";

/**
 * The chooser's top bar (founder, 2026-08-20).
 *
 * ⚠️ THIS BAR IS THE ONLY WAY OFF THE CHOOSER. `/app` has no sidebar any more,
 * so Settings, Change password and Sign out are reachable from nowhere else on
 * that screen. `user-menu.tsx` already warned that it is the sole route to two
 * of them; with the sidebar gone from this page, "sole route" stops being a
 * warning and becomes the thing a customer is stranded by if it breaks.
 *
 * Rendered with `renderToStaticMarkup` — no DOM, no clicks — which works only
 * because the menu keeps its items in the markup when shut, hidden with a
 * class. That was deliberate in `user-menu.tsx` for exactly this reason.
 */

const IDENTITY: SidebarIdentity = {
  organisationId: "11111111-1111-4111-8111-111111111111",
  organisation: { name: "Northgate Plumbing", initials: "NP", roleLabel: "Owner" },
  user: { name: "Sam Okafor", email: "sam.okafor@northgate.co.uk", initials: "SO" },
};

const render = (identity: SidebarIdentity = IDENTITY) =>
  renderToStaticMarkup(
    <ChooserHeaderBody identity={identity} signOutSlot={<span>Sign out</span>} />,
  );

describe("the chooser's top bar", () => {
  it("carries every account destination, because nothing else on this page does", () => {
    const html = render();

    for (const item of ACCOUNT_MENU_ITEMS) {
      expect(html, `${item.label} is unreachable from the chooser`).toContain(item.label);
      expect(html).toContain(item.href);
    }
    expect(html, "no way to sign out from the chooser").toContain("Sign out");
  });

  it("says who is signed in", () => {
    const html = render();

    expect(html).toContain("Sam Okafor");
    expect(html).toContain("sam.okafor@northgate.co.uk");
  });

  it("carries the wordmark, so the page does not look like it failed to load", () => {
    expect(render()).toContain("eva");
  });

  /**
   * ⚠️ THE TRIGGER WEARS THE LIGHT PALETTE, because this bar sits on the page
   * background and not in the dark sidebar. Wearing the sidebar's own trigger
   * colours here would be the `text-destructive` mistake with a different
   * ending: not invisible, but charcoal-on-charcoal.
   *
   * The dark AVATAR chip and the dark dropdown PANEL are deliberate and stay —
   * a dark menu panel on a light bar is an ordinary pattern, and it keeps one
   * set of item classes instead of two that drift apart.
   */
  it("wears the light trigger, not the sidebar's", () => {
    const html = render();

    expect(html).toContain("bg-surface");
    expect(html).toContain("text-foreground");
    expect(html).not.toContain("bg-sidebar-hover p-2");
  });

  /**
   * ⚠️ NOT TESTED HERE: WHICH WAY THE MENU OPENS. The panel is `hidden` when
   * shut and its direction classes are not in the markup at all, so a static
   * render genuinely cannot see it — asserting on it would have been a test
   * that passes for the wrong reason. `PANEL_CLASS` in `user-menu.tsx` is a
   * `Record` keyed by placement, so a missing variant is a compile error; the
   * direction itself is a thing to LOOK at, and it is written down as such.
   */
  it("wires the trigger to the menu it controls", () => {
    const html = render();

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
  });
});
