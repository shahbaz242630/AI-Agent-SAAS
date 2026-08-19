import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { showsAppChrome } from "@/lib/navigation";

/**
 * ⚠️ FOUND BY WALKING THE PRODUCT, NOT BY READING IT (2026-08-11). The founder
 * opened the invoices screen and asked why three links at the bottom —
 * "Clients", "Invoice settings", "Your account" — were there at all. They were
 * navigation from before the sidebar existed, and one of them was worse than
 * redundant: "Your account" pointed at `/app`, which stopped being the account
 * page in slice 1.9 and is now Home. A label that promises one screen and
 * delivers another.
 *
 * Slice 1.9 removed the same footer from the reminders screen and left a note
 * saying so. Six other screens kept theirs, because a note only works on
 * somebody who reads the file it is in. This works on somebody who does not.
 */

const APP_SCREENS = fileURLToPath(new URL("../src/app/app", import.meta.url));

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return entry === "page.tsx" ? [full] : [];
  });
}

/** `app/app/settings/mailbox/page.tsx` → `/app/settings/mailbox` */
function routeOf(file: string): string {
  const relative = file
    .slice(APP_SCREENS.length)
    .replace(/\\/g, "/")
    .replace(/\/page\.tsx$/, "");
  return `/app${relative}`;
}

const screens = pageFiles(APP_SCREENS).map((file) => ({
  route: routeOf(file),
  text: readFileSync(file, "utf8")
    // Comments name the defect on purpose, so they are not evidence of it.
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1"),
}));

describe("screens inside the app shell", () => {
  it("finds every screen (a guard over an empty list proves nothing)", () => {
    expect(screens.length).toBeGreaterThan(8);
    expect(screens.map((s) => s.route)).toContain("/app/invoice-chasing/invoices");
  });

  /**
   * ⚠️ THE SIDEBAR IS THE WAY HOME. Every screen that renders inside the shell
   * has it, so a second link to `/app` in the body is duplicate navigation at
   * best — and at worst it is the one that gets a stale label, because nobody
   * revisits a link that still works.
   */
  it("never links to Home in the body — the sidebar already does", () => {
    const offenders = screens
      .filter((screen) => showsAppChrome(screen.route))
      .filter((screen) => /href="\/app"/.test(screen.text));

    expect(offenders.map((screen) => screen.route)).toEqual([]);
  });

  /**
   * ⚠️ CHROME-FREE SCREENS ARE THE EXCEPTION AND MUST KEEP THEIR WAY OUT.
   * Onboarding and the create-organisation page render with no sidebar, so
   * removing their link would leave somebody with no exit at all. They are
   * allowed a link to `/app` — the rule is only that it must not be labelled as
   * something `/app` is not.
   */
  it("keeps an exit on the screens that have no sidebar", () => {
    for (const route of ["/app/onboarding", "/app/organisations/new"]) {
      const screen = screens.find((candidate) => candidate.route === route);
      expect(screen, `${route} has moved`).toBeDefined();
      expect(showsAppChrome(route)).toBe(false);
      expect(screen?.text, `${route} has no way out`).toMatch(/href="\/app"/);
    }
  });

  /**
   * The labels that were wrong. `/app` was an account page, and before that a
   * list of organisations; it has been Home since slice 1.9. Any screen still
   * calling it by an old name is pointing somebody somewhere they did not
   * choose.
   */
  it("calls nothing by the names /app used to have", () => {
    const stale = [/Your account/, /Back to your organisations/];

    for (const screen of screens) {
      for (const label of stale) {
        expect(screen.text, `${screen.route} still says ${label}`).not.toMatch(label);
      }
    }
  });
});
