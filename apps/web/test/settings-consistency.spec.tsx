import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoOrganisation, SettingsShell } from "@/app/app/settings/settings-shell";
import { SETTINGS_TABS } from "@/app/app/settings/settings-tabs";

/**
 * The settings screens, held to one frame (founder ruling 2026-08-30).
 *
 * ⚠️ THERE ARE FOUR SINCE 2026-09-01 — MAILBOX LEFT. A mailbox belongs to one
 * product (ruling 36), so its setup moved inside each product and there is no
 * organisation-wide mailbox screen any more. Its controls moved with it, which
 * is why the button scan below reaches into `capabilities/mailbox` too: a guard
 * that silently stops covering the file it was written for is worse than no
 * guard, and that exact file carried one of the five wrong buttons.
 *
 * ⚠️ THIS EXISTS BECAUSE READING ONE FILE AT A TIME CANNOT SEE THE DEFECT.
 * Every one of these screens was correct on its own. Side by side they used
 * three content widths (Reminders used two, on itself), four card paddings,
 * five wordings of one refusal, and three of the five dead-ended a customer
 * with no organisation while the other two handed them the link that fixes it.
 * Nobody wrote any of that on purpose — it is what happens when the shape of a
 * page is retyped in each file rather than imported.
 *
 * ⚠️ THE SOURCE SCAN IS A PROXY AND THE LIMIT IS WORTH STATING. The five pages
 * are async server components that read Supabase, so they cannot be rendered
 * here; what CAN be proved is that none of them hand-rolls the frame any more,
 * which is the thing that drifts. `SettingsShell` itself is rendered properly
 * below — the fix's actual output, not just its absence.
 *
 * ⚠️ AND EVERY PROBE HERE HAS A CASE THAT MUST FAIL (habit 3). The scanner is
 * run against a deliberately bad sample at the bottom: a check that cannot go
 * red is not evidence, and this repo has been fooled by one before.
 */

const SETTINGS_DIR = fileURLToPath(new URL("../src/app/app/settings", import.meta.url));

const SETTINGS_PAGES = ["reminders", "invoices", "modules", "do-not-contact"] as const;

/** Where the mailbox screen and its controls went (slice 3.1c-0). Scanned by
 *  the button rules below alongside the settings folder, so the move did not
 *  quietly shrink what they cover. */
const MAILBOX_DIR = fileURLToPath(new URL("../src/capabilities/mailbox", import.meta.url));

/**
 * ⚠️ COMMENTS ARE NOT CLASSES — the same guard `design-tokens.spec.ts` needed,
 * for the same reason. `settings-shell.tsx` explains this fix by NAMING the
 * widths it removed, and the mailbox screen's note describes the wrong-shaped
 * button it used to carry. Flagging prose would force the next person to delete
 * the explanation to get a green suite, which is how the knowledge is lost.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The frame, retyped. Each of these was in at least one settings page before
 * 2026-08-30 and belongs in exactly one file now.
 */
const HAND_ROLLED = [
  { what: "the page shell", pattern: /max-w-\[1080px\]/ },
  { what: "the page title", pattern: /font-display text-\[29px\]/ },
  { what: "a card surface", pattern: /border border-border bg-surface/ },
  { what: "its own content width", pattern: /max-w-(?:2xl|3xl)/ },
  { what: "the no-organisation dead end", pattern: /Create an organisation first/ },
] as const;

function handRolledIn(source: string): string[] {
  const body = stripComments(source);
  return HAND_ROLLED.filter(({ pattern }) => pattern.test(body)).map(({ what }) => what);
}

describe("the settings frame", () => {
  it("puts the heading, the tabs and the content in one column", () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        title="Do not contact"
        subtitle="People Eva will never write to."
        current="do-not-contact"
      >
        <p>the body</p>
      </SettingsShell>,
    );

    // One shell, one column — not a width per section.
    expect(html.match(/max-w-\[1080px\]/g)).toHaveLength(1);
    expect(html.match(/max-w-2xl/g)).toHaveLength(1);

    // ⚠️ THE TABS SIT INSIDE THE COLUMN, WHICH IS THE WHOLE POINT OF THE
    // RULING. They used to render at the full 1080px above content that stopped
    // at 672px, so the navigation overhung the page on every settings screen.
    expect(html.indexOf("max-w-2xl")).toBeLessThan(html.indexOf("<nav"));

    expect(html).toContain("Do not contact");
    expect(html).toContain("People Eva will never write to.");
    expect(html).toContain("the body");
  });

  it("renders every tab and marks the current one", () => {
    const html = renderToStaticMarkup(
      <SettingsShell title="Currency" subtitle="What a new invoice starts as." current="invoices">
        <p>body</p>
      </SettingsShell>,
    );
    for (const tab of SETTINGS_TABS) expect(html).toContain(tab.label);
    // The active pill is announced, not merely coloured.
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  /**
   * ⚠️ THE FIX FOR A DEAD END, ASSERTED ON WHAT IT PRINTS. Defect #124 shipped
   * because every test read the fact and none read the row. The fact here is
   * "the component exists"; what matters is that it puts a reachable link on
   * the screen.
   */
  it("offers a way out when there is no organisation", () => {
    const html = renderToStaticMarkup(<NoOrganisation />);
    expect(html).toContain("Create an organisation first.");
    expect(html).toContain('href="/app/organisations/new"');
    // The sentence and the link are not jammed together (Next 16 eats the space
    // in the neighbouring shape — see the note on the component).
    expect(html).toContain("first. <a");
  });
});

describe("no settings page hand-rolls the frame", () => {
  for (const page of SETTINGS_PAGES) {
    it(`${page} uses the shared frame`, () => {
      const source = readFileSync(`${SETTINGS_DIR}/${page}/page.tsx`, "utf8");
      expect(handRolledIn(source)).toEqual([]);
      // It cannot be using the frame without importing it.
      expect(source).toContain("settings-shell");
    });
  }

  /**
   * ⚠️ THE CASE THAT MUST FAIL. Without this, every assertion above passes just
   * as happily against a scanner whose regexes match nothing at all — which is
   * exactly how a probe once reported 799 dead exports and every table missing.
   */
  it("catches a page that goes back to hand-rolling it", () => {
    const relapsed = `
      export default function Page() {
        return (
          <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
            <section className="flex w-full max-w-3xl flex-col gap-2">
              <h1 className="font-display text-[29px] leading-tight font-semibold">Whatever</h1>
            </section>
            <div className="rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
              Create an organisation first.
            </div>
          </main>
        );
      }`;
    expect(handRolledIn(relapsed)).toEqual([
      "the page shell",
      "the page title",
      "a card surface",
      "its own content width",
      "the no-organisation dead end",
    ]);
  });

  /** And that prose describing the old shapes is not mistaken for the shapes. */
  it("does not flag a comment that explains what was removed", () => {
    const explained = `
      /** This page used to set max-w-3xl and its own font-display text-[29px] heading. */
      // ...inside a border border-border bg-surface card, no less.
      export default function Page() {
        return <SettingsShell title="X" subtitle="Y" current="modules">body</SettingsShell>;
      }`;
    expect(handRolledIn(explained)).toEqual([]);
  });
});

/**
 * ⚠️ THE PAGES WERE ONLY HALF THE SCREEN, AND THE HALF NOBODY PRESSES.
 *
 * After the five page files were aligned, the buttons a customer actually
 * clicks were still hand-written in the client components beside them — and the
 * SAME wrong shape had been copied five times: the card radius instead of the
 * control radius, `text-sm` instead of 13px, `font-medium` instead of semibold,
 * and no shadow or hover at all. It was on Connect mailbox, on Turn on, on Turn
 * off, on Save seats and on Currency's Save, while Reminders' Save next door
 * was the correct shape. Five copies is not a mistake anybody made; it is what
 * happens when the kit has no component for "submit, at dashboard size" and
 * each form invents one.
 *
 * The scan is deliberately narrow — a primary fill wearing the CARD radius,
 * which is the fingerprint all five shared. `settings-tabs.tsx` colours its
 * active pill `bg-primary` and is not a button, so a broader rule would flag
 * the one correct use in the folder.
 */
const HAND_ROLLED_PRIMARY = /rounded-\[var\(--radius-card\)\] bg-primary/;

function settingsSources(): [string, string][] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return entry.endsWith(".tsx") ? [full] : [];
    });
  const read = (dir: string, prefix: string): [string, string][] =>
    walk(dir).map((full) => [
      prefix + relative(dir, full).split(sep).join("/"),
      readFileSync(full, "utf8"),
    ]);
  // The mailbox screen and its controls, which used to live under settings.
  return [...read(SETTINGS_DIR, ""), ...read(MAILBOX_DIR, "capabilities/mailbox/")];
}

describe("no settings control is built by hand", () => {
  it("covers every tsx file in the folder, not just the pages", () => {
    // A scan that silently found nothing to read would pass everything below.
    const names = settingsSources().map(([name]) => name);
    expect(names.length).toBeGreaterThanOrEqual(12);
    // ⚠️ NAMED EXPLICITLY BECAUSE IT MOVED. `mailbox-controls.tsx` carried one
    // of the five wrong buttons; when the screen moved into the products this
    // scan would otherwise have stopped covering it and still gone green.
    expect(names).toContain("capabilities/mailbox/mailbox-controls.tsx");
    expect(names).toContain("capabilities/mailbox/mailbox-screen.tsx");
    expect(names).toContain("modules/module-controls.tsx");
  });

  it("uses the kit's primary button everywhere", () => {
    const offenders = settingsSources()
      .filter(([, source]) => HAND_ROLLED_PRIMARY.test(stripComments(source)))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  /** ⚠️ THE CASE THAT MUST FAIL — the fingerprint, as it actually appeared. */
  it("catches the shape that was copied five times", () => {
    const relapsed =
      'const PRIMARY = "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium";';
    expect(HAND_ROLLED_PRIMARY.test(stripComments(relapsed))).toBe(true);
  });
});

describe("the settings tabs describe themselves truthfully", () => {
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

  /**
   * ⚠️ THE DOCBLOCK SAID "FOUR" FOR NINE DAYS AFTER THE FIFTH TAB LANDED, and
   * the note adding that fifth tab is in the same file thirty lines below. Copy
   * has no assertions unless somebody writes them — this is the assertion.
   */
  it("counts its own tabs correctly in the comment above them", () => {
    const source = readFileSync(`${SETTINGS_DIR}/settings-tabs.tsx`, "utf8");
    const word = NUMBER_WORDS[SETTINGS_TABS.length];
    expect(word).toBeDefined();
    expect(source).toContain(`The ${word} settings screens`);
    expect(source).toContain(`THERE ARE ${word!.toUpperCase()} SCREENS BEHIND IT`);
  });

  it("gives every tab a distinct route and label", () => {
    expect(new Set(SETTINGS_TABS.map((t) => t.href)).size).toBe(SETTINGS_TABS.length);
    expect(new Set(SETTINGS_TABS.map((t) => t.label)).size).toBe(SETTINGS_TABS.length);
  });
});
