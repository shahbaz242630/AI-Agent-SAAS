import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Table, TableCell, TableRow, type TableColumn } from "@/components/ui";
import { BOOK_COLUMNS, BOOK_HEADINGS } from "@/app/app/invoice-chasing/invoices/book-columns";

/**
 * Every table in the product, held to one treatment (founder, 2026-08-31 — the
 * book and the chasing screen "still follow old, not our new style").
 *
 * ⚠️ THE KIT HAD NO TABLE UNTIL TODAY, AND THAT IS THE WHOLE STORY. Sixteen
 * components and not one of them a table, so SEVEN files hand-rolled `<table>`
 * — two of them in the same product, disagreeing:
 *
 *   chasing   uppercase headers, no rule beneath, `py-2.5`, rows `border-t`
 *   invoices  sentence case, `border-b` beneath, `pt-1 pb-2.5`, rows `border-b`
 *
 * Nobody chose either; both were typed months apart with the other file closed.
 * Exactly the failure that copied one wrong primary button five times.
 *
 * ⚠️ SENTENCE CASE IS A RULE, NOT THE MAJORITY VOTE. The design package uses
 * uppercase for pills and small section labels and never for a column heading,
 * which is why `clients` was changed FROM uppercase on 2026-08-18. Uppercase
 * was the first instinct here and it was wrong; this test is what stops the
 * next person following the same instinct.
 */

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Comments quote the shapes being removed — never scan them. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const COLUMNS: readonly TableColumn[] = [
  { label: "Date" },
  { label: "Amount", align: "right" },
  { label: "Actions", srOnly: true, sticky: true },
];

function renderTable(): string {
  return renderToStaticMarkup(
    <Table minWidth={640} columns={COLUMNS}>
      <TableRow>
        <TableCell>1 Sept</TableCell>
        <TableCell align="right">£10.00</TableCell>
        <TableCell sticky>…</TableCell>
      </TableRow>
    </Table>,
  );
}

describe("the shared table", () => {
  it("sets its headers in sentence case, never uppercase", () => {
    const html = renderTable();
    const header = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
    expect(header).not.toContain("uppercase");
    expect(header).toContain("Date");
  });

  /**
   * ⚠️ THE DEFECT THE MERGE NEARLY INTRODUCED. The header draws a `border-b`;
   * if rows also drew a `border-t` the two hairlines would stack directly under
   * it and read as one heavy 2px rule. NEITHER hand-rolled table had this bug —
   * it would have been created by combining them carelessly.
   */
  it("does not stack a row border on top of the header rule", () => {
    const html = renderTable();
    expect(html.slice(html.indexOf("<thead"), html.indexOf("</thead>"))).toContain("border-b");
    const body = html.slice(html.indexOf("<tbody"));
    expect(body).not.toContain("border-t");
    expect(body).toContain("border-b");
  });

  it("carries the minimum width as a style, because Tailwind cannot build it", () => {
    // A class here would be generated from a variable and silently emitted as
    // nothing, letting a dense table squash instead of scroll.
    expect(renderTable()).toContain("min-width:640px");
  });

  it("right-aligns only the columns that asked, and pins only the sticky one", () => {
    const html = renderTable();
    expect(html.match(/text-right/g)).toHaveLength(2); // the Amount th and td
    expect(html.match(/sticky right-0/g)).toHaveLength(2); // the Actions th and td
  });

  it("reads a controls column to a screen reader without drawing it", () => {
    expect(renderTable()).toContain('<span class="sr-only">Actions</span>');
  });
});

describe("the book's columns", () => {
  /**
   * `BOOK_COLUMNS` is derived from this list rather than typed beside it, so a
   * drift is impossible rather than merely caught. This asserts the list itself
   * still matches the header the screen promises.
   */
  it("still has the ten the screen was built for, and the count follows it", () => {
    expect(BOOK_HEADINGS).toHaveLength(10);
    // Derived, not typed — a drift is impossible rather than merely caught.
    expect(BOOK_COLUMNS).toBe(BOOK_HEADINGS.length);
    expect(BOOK_HEADINGS[0]?.label).toBe("Client");
    expect(BOOK_HEADINGS.at(-1)).toMatchObject({ label: "Actions", srOnly: true, sticky: true });
  });

  it("puts money on the right and nothing else", () => {
    const right = BOOK_HEADINGS.filter((column) => column.align === "right").map((c) => c.label);
    expect(right).toEqual(["Amount", "Outstanding"]);
  });
});

/**
 * The two screens the founder named. Both must be on the shared frame and the
 * shared table — a page file that looks aligned while hand-rolling its own
 * `<table>` beside it is the exact trap §0 of the handoff warns about.
 */
const ROLLED_OUT = [
  "app/app/invoice-chasing/invoices/page.tsx",
  "app/app/invoice-chasing/invoices/book-rows.tsx",
  "app/app/invoice-chasing/chasing/page.tsx",
];

describe("invoices and chasing, on one frame", () => {
  it("neither screen hand-rolls a table, a row or a cell any more", () => {
    for (const file of ROLLED_OUT) {
      const body = stripComments(readFileSync(join(WEB_SRC, file), "utf8"));
      expect(body, `${file} still hand-rolls <table>`).not.toMatch(/<table\b/);
      expect(body, `${file} still hand-rolls <thead>`).not.toMatch(/<thead\b/);
      expect(body, `${file} still hand-rolls a <td>`).not.toMatch(/<td\b/);
      expect(body, `${file} still hand-rolls a <tr>`).not.toMatch(/<tr\b/);
    }
  });

  it("neither screen keeps its own page shell or its own width", () => {
    for (const file of ROLLED_OUT) {
      const body = stripComments(readFileSync(join(WEB_SRC, file), "utf8"));
      expect(body, `${file} still hand-rolls the shell`).not.toMatch(/max-w-\[(1080|1600)px\]/);
      expect(body, `${file} still sets its own width`).not.toMatch(/max-w-6xl/);
    }
  });

  /**
   * Habit 3: a check that cannot go red is not evidence. The scanner is run
   * against the code as it stood this morning.
   */
  it("rejects the shapes these screens carried before today", () => {
    const before = `
      <main className="flex w-full max-w-[1600px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
        <div className="flex w-full max-w-6xl flex-col gap-3" />
        <table className="w-full min-w-[1200px] border-collapse text-sm">
          <thead><tr><th className="px-3 pt-1 pb-2.5">Client</th></tr></thead>
        </table>
      </main>`;
    expect(before).toMatch(/<table\b/);
    expect(before).toMatch(/max-w-\[(1080|1600)px\]/);
    expect(before).toMatch(/max-w-6xl/);
  });

  it("read the files it claims to have read", () => {
    // Guards against a rename turning every probe above into a silent no-op.
    const found = walk(WEB_SRC).map((f) => relative(WEB_SRC, f).replace(/\\/g, "/"));
    for (const file of ROLLED_OUT) expect(found).toContain(file);
  });
});
