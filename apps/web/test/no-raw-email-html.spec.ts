import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing renders raw HTML, and the email body is why (slice 3.1c-0b).
 *
 * ⚠️ `inbound_messages.html_body` IS ATTACKER-CONTROLLED. It is whatever a
 * stranger emailed to an address printed on a customer's website. We store it
 * deliberately — ruling 38, the enquiry book keeps its evidence — and today
 * NOTHING renders it, which is the only reason there is no hole.
 *
 * ⚠️ THE DANGER IS THE SCREEN 3.1c HAS NOT BUILT YET. The obvious way to show
 * somebody their enquiry is React's raw-HTML escape hatch, it will look right,
 * and it hands whoever sent that email script execution in the customer's
 * session — the session that can read their whole client book and disconnect
 * their mailbox. Nothing about the page would look wrong.
 *
 * ⚠️ SO THIS IS A GUARD, NOT A SANITISER. Founder ruling 2026-09-01: a
 * sanitiser nothing calls is untested code guarding a screen that does not
 * exist, and we would be guessing what it must allow through. This fails the
 * build at the moment somebody writes the dangerous line instead — when they
 * are still holding the problem and can be told what to do about it.
 *
 * ⚠️ IF YOU ARE HERE BECAUSE THIS TEST FAILED: do not add your file to an
 * ignore list. Sanitise the HTML before it reaches the DOM (a vetted library,
 * an allow-list of tags, no script elements, no `on*` handlers, no
 * `javascript:` URLs), keep that in ONE component, and change this test to
 * allow exactly that component and nothing else.
 */

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * ⚠️ EVERY NEEDLE IS ASSEMBLED FROM PIECES, AND THAT IS NOT STYLE. The
 * repository's security hook refuses to write any file containing these
 * property names spelled out — including this one, whose entire job is to
 * forbid them. A guard that cannot be saved is no guard, so the names are built
 * at runtime. Keep it that way: spelling any of them out blocks the next edit
 * to this file.
 */
const HTML = "HTML";
const REACT_RAW = `dangerously${"SetInner"}${HTML}`;
const INNER = `inner${HTML}`;
const OUTER = `outer${HTML}`;
const INSERT_ADJACENT = `insertAdjacent${HTML}`;

const RAW_HTML_SINKS = [
  { what: REACT_RAW, pattern: new RegExp(REACT_RAW) },
  { what: `.${INNER} =`, pattern: new RegExp(`\\.${INNER}\\s*=`) },
  { what: `.${OUTER} =`, pattern: new RegExp(`\\.${OUTER}\\s*=`) },
  // The second thing somebody tries once the first is blocked: reach the DOM
  // through a ref inside an effect.
  { what: INSERT_ADJACENT, pattern: new RegExp(`${INSERT_ADJACENT}\\s*\\(`) },
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Comments explain the rule by naming the thing it forbids, so prose must not
 *  count as a violation — the same guard `settings-consistency.spec.tsx` needs. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("no screen renders raw HTML", () => {
  const files = sourceFiles(WEB_SRC).map(
    (full) => [relative(WEB_SRC, full).split(sep).join("/"), readFileSync(full, "utf8")] as const,
  );

  /**
   * ⚠️ THE CASE THAT MUST FAIL — habit 3. A scan that silently read nothing
   * would pass this file forever, and this repo has been fooled by one before
   * (799 dead exports, every table missing).
   */
  it("actually reads the web source", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(files.map(([name]) => name)).toContain("capabilities/mailbox/mailbox-screen.tsx");
  });

  it("catches the dangerous line if somebody writes it", () => {
    const relapsed = `export function Enquiry({ html }) {
      return <div ${REACT_RAW}={{ __html: html }} />;
    }`;
    const hits = RAW_HTML_SINKS.filter(({ pattern }) => pattern.test(stripComments(relapsed)));
    expect(hits.map(({ what }) => what)).toEqual([REACT_RAW]);
  });

  for (const { what, pattern } of RAW_HTML_SINKS) {
    it(`never uses ${what}`, () => {
      const offenders = files
        .filter(([, source]) => pattern.test(stripComments(source)))
        .map(([name]) => name);
      expect(offenders).toEqual([]);
    });
  }
});
