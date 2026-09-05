import { describe, expect, it } from "vitest";
import { pageCountFor, pageWindow } from "@/lib/pagination";

/**
 * The numbers a pager shows (the enquiry book, 2026-09-05).
 *
 * The rule is small enough to hold in one head and easy enough to get off
 * by one, which is the failure a customer sees as a missing page.
 */
describe("the page window", () => {
  it("shows every page when there are few", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the ends and the neighbours, and gaps the rest", () => {
    expect(pageWindow(6, 12)).toEqual([1, "gap", 5, 6, 7, "gap", 12]);
    expect(pageWindow(1, 12)).toEqual([1, 2, "gap", 12]);
    expect(pageWindow(12, 12)).toEqual([1, "gap", 11, 12]);
  });

  /** "1 … 3" hides a single page and saves nothing; the page is shown instead. */
  it("never hides exactly one page behind a gap", () => {
    expect(pageWindow(4, 12)).toEqual([1, 2, 3, 4, 5, "gap", 12]);
    expect(pageWindow(9, 12)).toEqual([1, "gap", 8, 9, 10, 11, 12]);
  });

  it("clamps a page that is out of range rather than drawing nonsense", () => {
    expect(pageWindow(0, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(99, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(2, 0)).toEqual([]);
  });
});

describe("the page count", () => {
  it("rounds up, and is never less than one", () => {
    expect(pageCountFor(0, 50)).toBe(1);
    expect(pageCountFor(50, 50)).toBe(1);
    expect(pageCountFor(51, 50)).toBe(2);
    expect(pageCountFor(312, 50)).toBe(7);
  });
});
