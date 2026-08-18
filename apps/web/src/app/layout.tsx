import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Two families, two jobs (2026-08-09 design handoff).
 *
 * ⚠️ THE DISPLAY FACE IS FOR MONEY AND TITLES ONLY. Bricolage Grotesque is a
 * variable-optical-size display face; set it at 13px for body text and it turns
 * a screen full of invoice rows into something harder to scan, not easier.
 * Figtree carries every figure a customer reads at speed.
 *
 * ⚠️ SELF-HOSTED SINCE 2026-08-12, AND IT IS A DEPLOY FIX RATHER THAN A DESIGN
 * ONE. These were `next/font/google`, which downloads the files from Google
 * DURING THE BUILD. Production builds in a fresh container with no cache, so
 * every deploy depended on Google answering at that moment — and one clean
 * build in three failed here with "Error while requesting resource", which
 * surfaces as twelve Turbopack errors indistinguishable from a compile error in
 * our own code. An hour hunting a bug that was never there, on the day we are
 * trying to ship. Every incremental build hid it, because the files were
 * already cached.
 *
 * The `.woff2` files in `../fonts` are the exact bytes that build downloaded,
 * lifted out of `.next/static/media`, so nothing about the rendering moved.
 *
 * ⚠️ ONE CALL PER UNICODE SUBSET, AND THE STACK ORDER IS LOAD-BEARING.
 * `next/font/local` has no per-file `unicode-range`, so the subsets Google
 * splits a variable font into cannot be a single call. They do not need to be:
 * CSS resolves a font family list PER GLYPH, so latin first with latin-ext
 * behind it finds an "ł" exactly as the unicode-range did. Dropping the extra
 * subsets would have been simpler and would have quietly re-rendered every
 * Polish, Czech and Vietnamese customer name in Arial.
 *
 * ⚠️ `adjustFontFallback` IS ON THE LAST ENTRY ONLY. It appends an Arial-metric
 * face to whichever family it is set on; set on the first, that face would
 * answer for every missing glyph before latin-ext was ever consulted — and the
 * accented characters this whole ordering exists to serve would silently render
 * in Arial anyway.
 *
 * ⚠️ `preload` FOLLOWS WHAT GOOGLE'S LOADER DID: the latin files only. They are
 * the ones nearly every byte on screen comes from; preloading all five would
 * put 97KB in front of the first paint to serve characters most pages never
 * contain.
 */

/**
 * ⚠️ EVERY VALUE BELOW IS WRITTEN OUT IN FULL, INCLUDING THE REPEATED
 * `"400 700"`. Next reads these calls statically at build time and refuses
 * anything that is not a literal — a shared `WEIGHT_RANGE` constant, which is
 * the obvious tidy-up, fails the build with "Font loader values must be
 * explicitly written literals". The repetition is the API's price, not an
 * oversight.
 *
 * `"400 700"` is a RANGE because both faces are variable: one file serves every
 * weight the design uses, which is why five files cover two families at four
 * weights each.
 */
const displayLatin = localFont({
  src: "../fonts/bricolage-grotesque-latin.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: true,
  adjustFontFallback: false,
});

const displayLatinExt = localFont({
  src: "../fonts/bricolage-grotesque-latin-ext.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const displayVietnamese = localFont({
  src: "../fonts/bricolage-grotesque-vietnamese.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  // Last in the stack, so this is where the metric-matched fallback belongs.
  adjustFontFallback: "Arial",
});

const bodyLatin = localFont({
  src: "../fonts/figtree-latin.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: true,
  adjustFontFallback: false,
});

const bodyLatinExt = localFont({
  src: "../fonts/figtree-latin-ext.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: "Arial",
});

/**
 * The two custom properties the whole design system reads, each a family stack
 * rather than a single name — see the subset note above.
 */
const DISPLAY_FAMILY = [displayLatin, displayLatinExt, displayVietnamese]
  .map((font) => font.style.fontFamily)
  .join(", ");

const BODY_FAMILY = [bodyLatin, bodyLatinExt].map((font) => font.style.fontFamily).join(", ");

export const metadata: Metadata = {
  title: "Eva — AI Business Communications Platform",
  description:
    "Eva is a modular AI communications platform for UK small businesses: invoice chasing, lead follow-up and AI reception.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en-GB"
      className="h-full antialiased"
      /* Set here rather than through next/font's own `variable` option: each
         call would declare its own property, and what the design system wants
         is one property holding the whole stack. */
      style={
        {
          "--font-display-family": DISPLAY_FAMILY,
          "--font-body-family": BODY_FAMILY,
        } as React.CSSProperties
      }
    >
      {/* ⚠️ `tabular-nums` ON THE WHOLE APP, DELIBERATELY. Money and counts sit
          in columns on every screen, and proportional digits make a column of
          amounts jitter — the reader's eye stops trusting the alignment before
          they consciously notice why. */}
      <body className="flex min-h-full flex-col tabular-nums">{children}</body>
    </html>
  );
}
