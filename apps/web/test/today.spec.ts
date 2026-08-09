import { describe, expect, it } from "vitest";
import { greeting, todayLabel } from "@/lib/today";

/**
 * What day it is, in the ORGANISATION's timezone (2026-08-09 design handoff).
 *
 * ⚠️ THE BUG THESE EXIST TO PREVENT IS ALREADY LIVE IN OUR INFRASTRUCTURE.
 * The web server runs in `us-west2`, eight hours behind London, so the server's
 * own clock would greet a Manchester customer with "Good afternoon" at
 * midnight and print YESTERDAY'S DATE above a book of overdue invoices. Every
 * case below is pinned to a fixed instant so it tests the RULE, not the day
 * the suite happens to run.
 */

/**
 * 2026-08-09 22:00 UTC. Sunday evening in London (23:00 BST) and already
 * Monday morning in Dubai (02:00) — the instant where the calendar day itself
 * disagrees between two customers.
 *
 * ⚠️ THE FIRST VERSION USED 23:30 UTC AND PROVED THE OPPOSITE OF WHAT IT SAID.
 * London is UTC+1 in August, so 23:30 UTC is already 00:30 on the 10th there —
 * the assertions failed, and the CODE was right. Britain being an hour ahead
 * of UTC for half the year is exactly the sort of thing this file is for.
 */
const UK_EVENING = new Date("2026-08-09T22:00:00Z");
/** 2026-08-09 08:00 UTC — Sunday morning in London. */
const UK_MORNING = new Date("2026-08-09T08:00:00Z");

describe("the greeting", () => {
  it("greets by the customer's clock, not the server's", () => {
    // One instant, three answers: evening in London, afternoon where our
    // servers actually are, and the next morning in Dubai.
    expect(greeting("Europe/London", UK_EVENING)).toBe("Evening");
    expect(greeting("America/Los_Angeles", UK_EVENING)).toBe("Afternoon");
    expect(greeting("Asia/Dubai", UK_EVENING)).toBe("Morning");
  });

  it("covers morning, afternoon and evening", () => {
    expect(greeting("Europe/London", UK_MORNING)).toBe("Morning");
    expect(greeting("Europe/London", new Date("2026-08-09T13:00:00Z"))).toBe("Afternoon");
    expect(greeting("Europe/London", new Date("2026-08-09T20:00:00Z"))).toBe("Evening");
  });

  /** Midnight is hour 0 and must read as morning, not as hour 24. */
  it("treats midnight as morning rather than falling off the end", () => {
    expect(greeting("Europe/London", new Date("2026-08-09T00:30:00Z"))).toBe("Morning");
  });

  /**
   * ⚠️ A BAD TIMEZONE COSTS US THE WORD, NOT THE SCREEN. "Hello" is true at
   * every hour; a guessed "Morning" is wrong half the time and sounds certain.
   */
  it("says something true rather than guessing when the zone is unknown", () => {
    expect(greeting("Not/AZone", UK_MORNING)).toBe("Hello");
    expect(greeting("", UK_MORNING)).toBe("Hello");
  });
});

describe("today's date", () => {
  /**
   * ⚠️ THE ONE THAT MATTERS. At 23:30 UTC it is already tomorrow in Dubai — so
   * a UAE customer must be told the 10th while a UK customer is told the 9th.
   * Getting this wrong prints the wrong day above a screen whose whole subject
   * is how late money is.
   */
  it("rolls over at the customer's midnight, not ours", () => {
    expect(todayLabel("Europe/London", UK_EVENING)).toBe("Sunday 9 August");
    expect(todayLabel("Asia/Dubai", UK_EVENING)).toBe("Monday 10 August");
    // And our own servers are on a third day-part again.
    expect(todayLabel("America/Los_Angeles", UK_EVENING)).toBe("Sunday 9 August");
  });

  it("writes the day out in full, without the year", () => {
    const label = todayLabel("Europe/London", UK_MORNING);
    expect(label).toBe("Sunday 9 August");
    expect(label).not.toContain("2026");
  });

  /** An unknown zone must not take the header down with it. */
  it("falls back rather than throwing on a zone Intl does not know", () => {
    expect(todayLabel("Not/AZone", UK_MORNING)).toBe("Sunday 9 August");
  });
});
