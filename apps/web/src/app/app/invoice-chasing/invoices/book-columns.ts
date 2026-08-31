import type { TableColumn } from "@/components/ui";

/**
 * The book's ten columns — the header the server renders, and the number of
 * cells every full-width row in `book-rows.tsx` spans.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE OF A REACT SERVER COMPONENTS RULE THAT TYPECHECK
 * AND LINT BOTH PASS (found by loading the page, 2026-08-31). These lived in
 * `book-rows.tsx` first, which carries `"use client"` — and a `"use client"`
 * module's exports become CLIENT REFERENCES when a server component imports
 * them. `BOOK_HEADINGS` arrived on the server as a proxy object rather than an
 * array, and the screen died with `columns.map is not a function`.
 *
 * `tsc` was happy, `eslint` was happy, and the 623-test suite was green,
 * because every one of them reads the file as ordinary TypeScript. Only running
 * it shows the difference. A plain module with no directive is importable from
 * both sides, which is what these two need.
 *
 * ⚠️ THE COUNT IS DERIVED, NEVER TYPED. Every full-width row spans
 * `BOOK_COLUMNS`: drift low and a message stops short of the right edge, drift
 * high and a phantom column widens the whole table. It was written inline as
 * `8` in three places until the client cell became three columns on 2026-08-18.
 * Deriving it makes the two impossible to disagree rather than merely checked.
 *
 * ⚠️ SENTENCE CASE, NOT UPPERCASE, AND IT IS A RULE NOT A PREFERENCE. The
 * design package uses uppercase for pills and small section labels —
 * "Outstanding · GBP", "Modules" — and NEVER for a column heading. `clients`
 * shouted its headers until 2026-08-18 and was changed to match this one.
 */
export const BOOK_HEADINGS: readonly TableColumn[] = [
  { label: "Client" },
  { label: "Email" },
  { label: "Phone" },
  { label: "Invoice" },
  { label: "Due" },
  { label: "Amount", align: "right" },
  { label: "Outstanding", align: "right" },
  { label: "Status" },
  { label: "Chasing" },
  // Pinned with its column — see its `TableCell` in `book-rows.tsx`.
  { label: "Actions", srOnly: true, sticky: true },
];

export const BOOK_COLUMNS = BOOK_HEADINGS.length;
