import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⚠️ THE SAME MISTAKE HAS NOW BEEN MADE THREE TIMES, SO IT GETS A TEST.
 *
 * `bg-destructive/10 text-destructive` has been written three times in this
 * codebase (`invoice-controls.tsx`, `book-rows.tsx`, and the slice 1.7 chase
 * activity screen). There is no `destructive` token — the palette calls it
 * `danger` — and Tailwind silently emits NOTHING for an unknown colour, so the
 * one status that should shout renders as plain unstyled text.
 *
 * It typechecks. It lints. It passes the whole gate. Two warning comments did
 * not stop it recurring, because a comment only works on someone who reads the
 * file they are copying FROM. This reads the token file and the source and
 * compares them, which works on someone who does not.
 */

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));
const TOKENS_CSS = fileURLToPath(
  new URL("../../../packages/design-system/tokens.css", import.meta.url),
);

/** Colour names the palette actually defines, e.g. `danger`, `muted-foreground`. */
function definedColourTokens(): Set<string> {
  const css = readFileSync(TOKENS_CSS, "utf8");
  const names = new Set<string>();
  for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) {
    names.add(match[1]!);
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * Tailwind utilities that share the `bg-`/`text-`/`border-` prefixes but are not
 * colours. Kept explicit rather than pattern-matched: an allowlist that is too
 * clever stops failing on the thing it exists to catch.
 */
const NON_COLOUR_UTILITIES = new Set([
  // text sizes
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  // text alignment and wrapping
  "left",
  "center",
  "right",
  "justify",
  "start",
  "end",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  // border sides — `border-b`, `border-t`, `border-x`…
  "b",
  "t",
  "l",
  "r",
  "x",
  "y",
  "s",
  "e",
  // border widths and styles
  "solid",
  "dashed",
  "dotted",
  "none",
  "collapse",
  "separate",
  // background utilities
  "clip",
  "cover",
  "contain",
  "fixed",
  "local",
  "scroll",
  "auto",
  "repeat",
]);

/**
 * ⚠️ COMMENTS ARE NOT CLASSES, AND THIS FILE PROVED IT THE FIRST TIME IT RAN.
 *
 * Both remaining `destructive` mentions are inside comments explaining the bug
 * — one of them written in the very commit that fixed it. Flagging those would
 * force the next person to delete the explanation in order to get a green
 * suite, which is precisely how the knowledge got lost the first three times.
 *
 * The `:` guard keeps `https://…` in a comment from swallowing the rest of its
 * line; block comments cover JSX `{/* … *\/}` too.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("design tokens", () => {
  const tokens = definedColourTokens();

  it("defines the palette the components expect", () => {
    for (const required of ["primary", "muted", "success", "warning", "danger"]) {
      expect(tokens.has(required)).toBe(true);
    }
  });

  /**
   * ⚠️ THE POINT OF THE WHOLE FILE. Every `bg-`/`text-`/`border-` class in
   * `apps/web` must name either a real token or a known non-colour utility.
   */
  it("uses no colour class that the palette does not define", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(WEB_SRC)) {
      const source = stripComments(readFileSync(file, "utf8"));
      /**
       * ⚠️ THE `(?:[lrtbxyse]-)?` IS A BLIND SPOT THIS TEST USED TO HAVE.
       * `border-l-danger` is a real Tailwind class that renders perfectly, and
       * the original pattern read its colour as `l-danger` and reported a
       * false failure. The fix consumes the direction segment rather than
       * exempting the class — so `border-l-destructive` is still caught, which
       * is the whole point. A guard that gets waved past on its first false
       * positive stops being a guard.
       */
      for (const match of source.matchAll(
        /\b(?:bg|text|border|ring|fill|stroke)-(?:([lrtbxyse])-)?([a-z][a-z0-9-]*)(?:\/\d+)?\b/g,
      )) {
        const name = match[2]!;
        if (tokens.has(name) || NON_COLOUR_UTILITIES.has(name)) continue;
        offenders.push(`${file.slice(WEB_SRC.length + 1)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ FOURTEEN LINKS WERE PAINTED IN THE BODY COLOUR (found by walking,
   * 2026-08-18). `text-primary` is `#211e19` — the near-black the palette uses
   * for headings and for the fill of dark buttons. Against body text it is
   * invisible as a link: no colour difference, and `hover:underline` only helps
   * somebody who already suspects there is something there to hover over.
   *
   * The worst of them sat alone at the foot of Mailbox settings reading
   * "Your clients", which looked like a heading with its section missing.
   *
   * The palette has `--color-link` (#92400e) for exactly this. Both classes are
   * real, so the sweep above cannot catch it — nothing is undefined here, it is
   * simply the wrong one, and it spread by being copied.
   */
  it("never paints a link in the body colour", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(WEB_SRC)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const classes = match[1] ?? match[2] ?? "";
        // `hover:underline` is what marks the element as a link rather than a
        // heading; `bg-primary` on a real button is untouched by this.
        if (!/\bhover:underline\b/.test(classes)) continue;
        if (!/\btext-primary\b/.test(classes)) continue;
        offenders.push(`${file.slice(WEB_SRC.length + 1)}: ${classes.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Named explicitly as well as caught by the sweep above, because this is the
   * specific string that keeps coming back and a future reader should see why.
   */
  it("never mentions `destructive`, which is not a token in this palette", () => {
    expect(tokens.has("destructive")).toBe(false);

    // The direction segment is optional here too — `border-l-destructive` is
    // the same mistake wearing a hat.
    const uses = sourceFiles(WEB_SRC).filter((file) =>
      /\b(?:bg|text|border)-(?:[lrtbxyse]-)?destructive\b/.test(
        stripComments(readFileSync(file, "utf8")),
      ),
    );
    expect(uses).toEqual([]);
  });
});
