import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT = join(WEB_ROOT, "src", "app", "layout.tsx");

/**
 * The fonts must not be fetched at build time (2026-08-12).
 *
 * ⚠️ THIS IS A SOURCE-READING GUARD BECAUSE THE FAILURE IT PREVENTS IS
 * INVISIBLE TO EVERY OTHER KIND OF TEST. `next/font/google` downloads the font
 * files from Google DURING THE BUILD, and once they are cached no local build
 * touches the network again — so the suite is green, the incremental build is
 * green, and the thing that breaks is a PRODUCTION DEPLOY, in a fresh container,
 * on a day the network hiccups. It broke one clean build in three when it was
 * found, and it presents as twelve Turbopack errors that read like a compile
 * error in our own code.
 *
 * Reverting to the Google loader is a one-line edit that looks tidier than what
 * replaced it. This is the line that has to say no.
 */
describe("the fonts ship with the repository", () => {
  const layout = readFileSync(LAYOUT, "utf8");

  /**
   * ⚠️ COMMENTS ARE STRIPPED FIRST, AND THE FIRST VERSION OF THIS TEST FAILED
   * BECAUSE THEY WERE NOT. The header of `layout.tsx` has to name
   * `next/font/google` to explain what was removed and why — and a guard that
   * reads prose then forbids documenting the very hazard it guards. Strip the
   * comments and the rule becomes what it was always meant to be: no CODE may
   * reach for the network loader.
   */
  const code = layout.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never loads a font from Google at build time", () => {
    expect(code).not.toContain("next/font/google");
    expect(code).not.toContain("fonts.googleapis.com");
    expect(code).not.toContain("fonts.gstatic.com");
  });

  it("loads them from files instead", () => {
    expect(code).toContain("next/font/local");
  });

  /**
   * Every file the layout names must actually be here. A missing `.woff2` fails
   * the build with a module-resolution error that says nothing about fonts, and
   * a font file is exactly the kind of binary that gets lost to a stray
   * `.gitignore` rule or a partial commit.
   */
  it("has every file the layout asks for, committed and present", () => {
    const referenced = [...code.matchAll(/["'](\.\.\/fonts\/[^"']+\.woff2)["']/g)].map(
      (match) => match[1] as string,
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const relative of referenced) {
      const path = join(WEB_ROOT, "src", "app", relative);
      expect(existsSync(path), `${relative} is referenced by layout.tsx but not on disk`).toBe(
        true,
      );
    }
  });

  /**
   * ⚠️ THE METRIC-MATCHED FALLBACK BELONGS AT THE END OF THE STACK, ONCE.
   * `next/font/local` appends an Arial-metric face to whichever family carries
   * `adjustFontFallback`. On an early entry it answers for every missing glyph
   * before the later subsets are consulted, so accented names render in Arial
   * while the file that has those glyphs sits unused — and nothing looks broken
   * enough for anyone to notice.
   */
  it("keeps one metric-matched fallback per family, not one per subset", () => {
    const arialFallbacks = code.match(/adjustFontFallback:\s*"Arial"/g) ?? [];
    expect(arialFallbacks).toHaveLength(2);
  });
});
