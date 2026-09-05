/**
 * Which page numbers a pager shows (the enquiry book, 2026-09-05).
 *
 * The first and last pages always; the current page and its neighbours; and
 * a gap where pages are skipped — except that a gap of exactly one page is
 * shown as that page, because "1 … 3" hides less than it saves.
 *
 * Platform, not product: it knows nothing about enquiries, and the invoice
 * book is the next screen that wants it.
 */
export type PageItem = number | "gap";

export function pageWindow(page: number, pageCount: number, around = 1): PageItem[] {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return [];
  // Up to seven pages fit as plain numbers; a gap would hide less than it
  // saves. (Two neighbours each side, both ends, and one that a gap of one
  // would show anyway.)
  if (pageCount <= 2 * around + 5) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const wanted = new Set<number>([1, pageCount]);
  for (let n = current - around; n <= current + around; n += 1) {
    if (n >= 1 && n <= pageCount) wanted.add(n);
  }
  const items: PageItem[] = [];
  let previous = 0;
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (previous !== 0 && n - previous === 2) items.push(previous + 1);
    else if (previous !== 0 && n - previous > 2) items.push("gap");
    items.push(n);
    previous = n;
  }
  return items;
}

/** How many pages a count makes — never fewer than one, so a pager has a page to be on. */
export function pageCountFor(totalCount: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, totalCount) / pageSize));
}
