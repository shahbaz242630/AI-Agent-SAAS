import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every in-app address written as a literal must be a screen that exists.
 *
 * ⚠️ THIS IS THE GUARD THAT WAS MISSING WHEN THE PRODUCTS GOT THEIR OWN URLS.
 * Slice 3.0 moved invoice chasing's screens from `/app/invoices` to
 * `/app/invoice-chasing/invoices` by moving the FOLDERS — which is how Next
 * builds a URL — and left 29 hand-written references across 11 files pointing
 * at the old addresses. The sidebar was fine, because `PRODUCT_NAV` builds its
 * hrefs with `moduleHref`. Everything written out by hand was a 404: the book's
 * five filter tabs, its search form, its paging, "Upload a spreadsheet" in
 * three places, the whole import flow's redirects, both "Back to your invoices"
 * chips, and the dashboard's "Add your first invoice".
 *
 * **Nothing failed.** Not the build, not `typecheck`, not the boundary rules,
 * not one web test — a string is a string, and Next only discovers the route is
 * missing when a person clicks it. It shipped on 2026-08-19 and was found the
 * next day by reading the file for an unrelated reason. A day, not a quarter,
 * only because a second product happened to be starting.
 *
 * ⚠️ THE FIX IS `moduleHref`, AND THIS TEST IS WHAT MAKES THE RULE REAL.
 * `lib/navigation.ts` already says hrefs must be built and never written out;
 * a rule stated in a comment is a rule until somebody is in a hurry. An href
 * built from `MODULE_CATALOGUE.slug` is a call expression, not a literal, so
 * it never reaches this test — correct by construction, and invisible here.
 * What is left for this test to see is exactly the hand-written kind.
 *
 * ⚠️ PARSED, NOT GREPPED, so comments never count. `navigation.ts` discusses a
 * "hypothetical `/app/invoices-archive`" and `product-hub.ts` mentions
 * `app/app/page.tsx`; a text search flags both and the test gets an allowlist,
 * which is how a guard starts lying. The TypeScript scanner sees string
 * literals and template literals only.
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(WEB_ROOT, "src");
const APP_DIR = join(SRC_DIR, "app");

/** A substitution inside a template literal — `${id}` — matching one segment. */
const HOLE = "*";

function walk(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

/**
 * Every route the App Router actually serves, in Next's own bracketed form.
 *
 * A folder is a route when it holds a `page.tsx`. Route groups — `(auth)` —
 * organise files without appearing in the URL, so their segment is dropped.
 */
function realRoutes(): string[] {
  const routes: string[] = [];
  walk(APP_DIR, (file) => {
    // ⚠️ THE BASENAME, NOT A SUFFIX — `endsWith` would take `add-row-page.tsx`
    // for a route and invent a screen that does not exist, which makes the
    // guard permissive in the one direction that hides a dead link.
    if (basename(file) !== "page.tsx") return;
    const segments = file
      .slice(APP_DIR.length, -"page.tsx".length)
      .split(/[/\\]/)
      .filter((segment) => segment !== "" && !segment.startsWith("("));
    routes.push(`/${segments.join("/")}`.replace(/\/$/, "") || "/");
  });
  return routes;
}

interface Link {
  readonly path: string;
  readonly where: string;
}

/** Every literal `/app…` address in the source, with where it was written. */
function writtenLinks(): Link[] {
  const links: Link[] = [];

  walk(SRC_DIR, (file) => {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const record = (text: string, node: ts.Node): void => {
      // A segment boundary, or `/applications` would be read as an app route.
      if (text !== "/app" && !text.startsWith("/app/")) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      links.push({
        path: text,
        where: `${file.slice(WEB_ROOT.length).replace(/\\/g, "/")}:${line + 1}`,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        record(node.text, node);
      } else if (ts.isTemplateExpression(node)) {
        // `/app/clients/${id}/invoices` becomes `/app/clients/*/invoices`.
        const text =
          node.head.text + node.templateSpans.map((span) => HOLE + span.literal.text).join("");
        record(text, node);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  });

  return links;
}

/**
 * ⚠️ A QUERY STRING AND A TRAILING SLASH ARE NOT PART OF THE ROUTE.
 * `/app/invoices?status=draft` is the book with a filter on it — the address
 * that has to exist is `/app/invoices`, and it is exactly the one that did not.
 */
function routePath(link: string): string {
  const withoutQuery = link.split("?")[0]?.split("#")[0] ?? "";
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/$/, "") : withoutQuery;
}

/**
 * Whether a written address lands on a real screen.
 *
 * A dynamic segment (`[customerId]`) accepts any one segment, and a template
 * substitution accepts any one segment in return — `/app/clients/*​/invoices`
 * is the same screen as `/app/clients/[customerId]/invoices`. Being generous
 * about the interpolated half is deliberate: its value is only known at
 * runtime, and a false failure here would get the whole test deleted.
 */
function resolves(link: string, routes: readonly string[]): boolean {
  const linkSegments = routePath(link).split("/");
  return routes.some((route) => {
    const routeSegments = route.split("/");
    if (routeSegments.length !== linkSegments.length) return false;
    return routeSegments.every((segment, index) => {
      const written = linkSegments[index] ?? "";
      if (segment.startsWith("[") || written === HOLE) return true;
      return segment === written;
    });
  });
}

describe("in-app links", () => {
  const routes = realRoutes();

  /**
   * The guard's own foundation. If the folder walk stops finding screens —
   * a rename, a move, a change in how Next marks a route — every link below
   * "resolves" against an empty list and this file passes while proving
   * nothing. Mistake 6 of 2026-08-20: a test that cannot fail has not passed.
   */
  it("finds the app's real routes", () => {
    expect(routes).toContain("/app");
    expect(routes).toContain("/app/invoice-chasing/invoices");
    expect(routes).toContain("/app/clients/[customerId]/invoices");
    expect(routes).not.toContain("/app/invoices");
  });

  it("only ever links to a screen that exists", () => {
    const dead = writtenLinks()
      .filter((link) => !resolves(link.path, routes))
      .map((link) => `${link.where} → ${link.path}`);

    expect(dead, "dead in-app links — build the href with moduleHref()").toEqual([]);
  });

  /**
   * ⚠️ AND THE MATCHER MUST REJECT, NOT ONLY ACCEPT. `resolves` is the whole
   * test; written slightly too generously it returns true for everything and
   * the assertion above becomes decoration.
   */
  it("rejects an address that is not a screen", () => {
    expect(resolves("/app/invoices", routes)).toBe(false);
    expect(resolves("/app/reminders", routes)).toBe(false);
    expect(resolves("/app/invoice-chasing/nope", routes)).toBe(false);
    expect(resolves("/app/invoice-chasing", routes)).toBe(true);
    expect(resolves("/app/invoice-chasing/invoices?status=draft", routes)).toBe(true);
    expect(resolves("/app/clients/*/invoices", routes)).toBe(true);
  });
});
