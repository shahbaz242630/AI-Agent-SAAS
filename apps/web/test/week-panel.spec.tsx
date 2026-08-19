import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeekPanel, dayMonth } from "@/app/app/invoice-chasing/week-panel";

/**
 * Eva's week, rendered (2026-08-09 design handoff).
 *
 * The counters are the part worth covering: a zero that disappears and a red
 * that should have been amber are both mistakes a reader acts on.
 */

const ROW = {
  id: "a1",
  invoiceId: "i1",
  customerId: "c1",
  invoiceNumber: "INV-2041",
  customerName: "Marsh & Doyle Ltd",
  stageKey: "overdue_7" as const,
  actionType: "email" as const,
  scheduledDate: "2026-08-08",
  status: "sent" as const,
  updatedAt: "2026-08-08T09:00:00Z",
};

const activity = (over: Partial<Parameters<typeof WeekPanel>[0]["activity"]> = {}) => ({
  counts: { sentLast7Days: 14, waiting: 3, failedLast7Days: 1, scheduled: 0 },
  waitingReason: null,
  noWorkingMailbox: false,
  recent: [ROW],
  upcoming: [],
  ...over,
});

describe("Eva this week, rendered", () => {
  it("shows all three counters, including the ones that are zero", () => {
    const html = renderToStaticMarkup(
      <WeekPanel
        activity={activity({
          counts: { sentLast7Days: 0, waiting: 0, failedLast7Days: 0, scheduled: 0 },
        })}
      />,
    );
    // Hiding a zeroed counter makes its absence ambiguous — is nothing broken,
    // or is the panel broken?
    expect(html).toContain("sent");
    expect(html).toContain("waiting");
    expect(html).toContain("didn&#x27;t send");
  });

  it("names the client, the invoice and the stage on each row", () => {
    const html = renderToStaticMarkup(<WeekPanel activity={activity()} />);
    expect(html).toContain("Marsh &amp; Doyle Ltd");
    expect(html).toContain("INV-2041");
    expect(html).toContain("8 Aug");
  });

  /**
   * ⚠️ THE PILL CARRIES A WORD, NOT JUST A COLOUR. "Waiting" and "Didn't send"
   * are the two states a customer must never confuse, and colour alone is
   * unreadable to anyone who cannot separate red from amber.
   */
  it("labels every status in words", () => {
    const html = renderToStaticMarkup(
      <WeekPanel activity={activity({ recent: [{ ...ROW, status: "failed" as const }] })} />,
    );
    expect(html).toContain("Didn&#x27;t send");
  });

  /** Nothing yet is a real answer — an empty table would read as a failure. */
  it("renders no table at all when there is no history", () => {
    const html = renderToStaticMarkup(<WeekPanel activity={activity({ recent: [] })} />);
    expect(html).not.toContain("<table");
  });
});

describe("the date on a chase row", () => {
  it("reads as a day and a month", () => {
    expect(dayMonth("2026-08-08")).toBe("8 Aug");
    expect(dayMonth("2026-12-25")).toBe("25 Dec");
  });

  /**
   * ⚠️ SPLIT, NEVER PARSED INTO A `Date`. `new Date("2026-08-08")` is midnight
   * UTC, and formatting that in a timezone west of Greenwich prints the 7th —
   * our own servers are in Oregon. The API already resolved this to a calendar
   * day in the organisation's timezone, and re-deriving it can only lose that.
   */
  it("never shifts the day, whatever the server's timezone is", () => {
    expect(dayMonth("2026-01-01")).toBe("1 Jan");
    expect(dayMonth("2026-03-31")).toBe("31 Mar");
  });

  it("hands back anything it does not understand, rather than inventing a date", () => {
    expect(dayMonth("not-a-date")).toBe("not-a-date");
    expect(dayMonth("")).toBe("");
  });
});
