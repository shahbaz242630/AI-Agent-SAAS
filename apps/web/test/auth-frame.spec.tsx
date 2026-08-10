import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AUTH_PANELS, AuthFrame, type AuthPanel } from "@/app/(auth)/auth-frame";

/**
 * The auth split screen, actually rendered (2026-08-09 design handoff).
 *
 * The interesting part of this file is not the layout — it is §"the panel
 * claims", which is a guard against the product telling a lie on the one screen
 * where a stranger decides whether to trust it.
 */

const render = (panel: AuthPanel, back?: { href: string; label: string }) =>
  renderToStaticMarkup(
    <AuthFrame panel={panel} {...(back ? { back } : {})}>
      <p>the form</p>
    </AuthFrame>,
  );

describe("the auth frame", () => {
  it("renders the form and the panel beside it", () => {
    const html = render(AUTH_PANELS.signIn);
    expect(html).toContain("the form");
    expect(html).toContain("While you were away, Eva kept chasing.");
  });

  it("leaves the back chip out entirely when there is nowhere to go back to", () => {
    expect(render(AUTH_PANELS.signedOut)).not.toContain("← ");
    expect(render(AUTH_PANELS.signIn, { href: "/", label: "Back" })).toContain("← Back");
  });

  /**
   * ⚠️ THE PANEL IS SUPPORT FOR THE FORM, NEVER A TOLL GATE IN FRONT OF IT. On
   * a phone the charcoal half is hidden rather than stacked, because stacked it
   * becomes a wall of reassurance to scroll past before reaching the password
   * field — the one thing the visitor came for.
   */
  it("hides the panel on small screens rather than stacking it above the form", () => {
    const html = render(AUTH_PANELS.signIn);
    expect(html).toMatch(/<aside[^>]*class="[^"]*\bhidden\b[^"]*lg:flex/);
  });
});

/**
 * ⚠️ THE PROTOTYPE'S PANELS STATED FACTS ABOUT A CUSTOMER WHO DOES NOT EXIST:
 * "14 reminders sent", "3 waiting", "Second reminder · INV-2041", "Next
 * scheduled run: tomorrow, 9:00 — 3 reminders due to go out for Fenwick
 * Joinery". Those are prototype furniture, and on a sign-in page — where nobody
 * is signed in — a number in that position reads as YOUR number.
 *
 * The same ruling as the testimonials: we have no customers, so there is
 * nothing true to put there, and inventing it is not ours to do. This test
 * reads the source and fails if any of it comes back.
 */
describe("the panel claims", () => {
  /**
   * ⚠️ COMMENTS ARE NOT COPY, AND THIS TEST PROVED IT ON ITS FIRST RUN. The
   * file it reads explains the ruling by NAMING the fabrications it refuses to
   * ship, so scanning the raw source failed on the very comment that exists to
   * stop the mistake — exactly what `design-tokens.spec.ts` hit, and it is
   * stripped here for the same reason. Forcing the next person to delete the
   * explanation in order to get a green suite is how the knowledge gets lost.
   */
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/(auth)/auth-frame.tsx", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("states no invented activity", () => {
    for (const invented of ["INV-2041", "INV-2038", "INV-2033", "Fenwick", "14 reminders"]) {
      expect(source).not.toContain(invented);
    }
  });

  /**
   * A digit in a panel is the shape the fabrications took, so the shape is what
   * is guarded — a future "3 waiting" is caught before anybody has to notice
   * that it is untrue. Prose is unaffected; none of the real copy counts
   * anything.
   */
  it("puts no number in any panel", () => {
    // `as` because each entry is its own literal shape; the loop wants the
    // shared one so an optional field can be read as absent rather than unknown.
    for (const [name, panel] of Object.entries(AUTH_PANELS) as [string, AuthPanel][]) {
      const text = [
        panel.headline,
        panel.lead ?? "",
        ...(panel.bullets ?? []),
        ...(panel.cards ?? []),
      ].join(" ");
      expect(`${name}: ${text}`).not.toMatch(/\d/);
    }
  });

  /** Every panel must actually say something — an empty one is a broken one. */
  it("gives every panel a headline and a body", () => {
    // `as` because each entry is its own literal shape; the loop wants the
    // shared one so an optional field can be read as absent rather than unknown.
    for (const [name, panel] of Object.entries(AUTH_PANELS) as [string, AuthPanel][]) {
      expect(panel.headline, `${name} headline`).toBeTruthy();
      const body = (panel.lead ? 1 : 0) + (panel.bullets?.length ?? 0) + (panel.cards?.length ?? 0);
      expect(body, `${name} body`).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠️ WE DO NOT OWN `eva.co.uk`. The design's signed-out screen offers "Back
   * to eva.co.uk"; whether we own it is one of the four decisions still with
   * the founder. A button carrying a domain we do not hold is a small lie on a
   * screen whose whole job is being trustworthy when somebody leaves.
   */
  it("never promises a domain we do not own", () => {
    expect(source).not.toContain("eva.co.uk");
  });
});
