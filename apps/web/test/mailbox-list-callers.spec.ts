import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every request for the mailbox list names the product it is asking for.
 *
 * ⚠️ THE GUARD FOR A SCREEN THAT FELL OVER ON PRODUCTION FOR FOUR DAYS. Slice
 * 3.1c-0 (PR #128, 2026-09-01) made `module` REQUIRED on
 * `GET /organisations/:id/mailboxes` — a mailbox belongs to one product, so a
 * list with no product would be an answer that looked right and was wrong,
 * and the api refuses it with a 400. The lead product's mailbox screen was
 * updated. Two Invoice Chasing screens were not: the Clients page, which
 * rethrows an unexpected error and so crashed to the error boundary; and the
 * Invoice Chasing home, which swallowed it and silently stopped nagging about
 * a missing mailbox. Build, typecheck, lint, boundaries and every web test
 * passed, because a URL is a string and nothing here calls the api. Found by
 * the founder opening Clients on 2026-09-05.
 *
 * ⚠️ PARSED, NOT GREPPED — the `app-links.spec.ts` precedent — so a comment
 * mentioning the path never counts, and a template literal is read with its
 * holes. The rule is on the WRITTEN address: any string or template literal
 * whose path ends in `/mailboxes` must carry `module=` in its query.
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(WEB_ROOT, "src");

/** A substitution inside a template literal — `${id}` — matching one segment. */
const HOLE = "*";

interface Caller {
  readonly text: string;
  readonly where: string;
}

function walk(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

/** Every literal in the source whose path is the mailbox list. */
function mailboxListCallers(): Caller[] {
  const callers: Caller[] = [];

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
      const path = text.split("?")[0] ?? "";
      // The LIST. `/mailboxes/connect` and `/mailboxes/:id` name one mailbox
      // and carry the product another way.
      if (!path.endsWith("/mailboxes")) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      callers.push({
        text,
        where: `${file.slice(WEB_ROOT.length).replace(/\\/g, "/")}:${line + 1}`,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        record(node.text, node);
      } else if (ts.isTemplateExpression(node)) {
        // `/organisations/${id}/mailboxes` becomes `/organisations/*/mailboxes`.
        const text =
          node.head.text + node.templateSpans.map((span) => HOLE + span.literal.text).join("");
        record(text, node);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  });

  return callers;
}

describe("requests for the mailbox list", () => {
  const callers = mailboxListCallers();
  const seen = (suffix: string): boolean =>
    callers.some((caller) => caller.where.split(":")[0]?.endsWith(suffix) ?? false);

  /**
   * The guard's own foundation: the three callers that exist today. If the
   * scan stops seeing them — a shared helper, a rename, a change in how the
   * address is written — the rule below passes over an empty list and proves
   * nothing. Mistake 6 of 2026-08-20: a test that cannot fail has not passed.
   */
  it("finds the callers it exists to check", () => {
    expect(seen("src/capabilities/mailbox/mailbox-screen.tsx"), "the mailbox screen").toBe(true);
    expect(seen("src/app/app/clients/page.tsx"), "the Clients page").toBe(true);
    expect(seen("src/app/app/invoice-chasing/page.tsx"), "the Invoice Chasing home").toBe(true);
  });

  it("names the product on every one of them", () => {
    const nameless = callers
      .filter((caller) => !/[?&]module=/.test(caller.text))
      .map((caller) => `${caller.where}: ${caller.text}`);
    expect(nameless, "a mailbox list with no product is a 400 from the api, not a list").toEqual(
      [],
    );
  });
});
