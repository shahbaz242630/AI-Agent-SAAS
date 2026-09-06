import { describe, expect, it } from "vitest";
import type { BusinessHours } from "@eva/types";
import { openingState, parseBusinessHours } from "../src/platform/organisations/opening-hours.js";

/**
 * "Are we open right now?" by the organisation's own clock (slice 3.5a).
 *
 * ⚠️ THE CASE THAT MUST FAIL IS THE WHOLE REASON THE TIMEZONE IS A SETTING: a
 * Dubai plumber at 09:30 Dubai time is open while a London one at the same
 * instant (06:30) is asleep. A function that read the server's clock, or the
 * default zone, would answer both the same — and the out-of-hours wording
 * would go to the wrong customer's enquirers.
 */

const NINE_TO_SIX: BusinessHours = {
  mon: { open: "09:00", close: "18:00" },
  tue: { open: "09:00", close: "18:00" },
  wed: { open: "09:00", close: "18:00" },
  thu: { open: "09:00", close: "18:00" },
  fri: { open: "09:00", close: "18:00" },
  sat: { open: "09:00", close: "13:00" },
  sun: null,
};

/** Monday 2026-09-07, 05:30 UTC: 09:30 in Dubai, 06:30 in London. */
const MONDAY_0530_UTC = new Date("2026-09-07T05:30:00Z");

describe("openingState", () => {
  it("is decided in the organisation's zone, not the server's", () => {
    expect(openingState(NINE_TO_SIX, "Asia/Dubai", MONDAY_0530_UTC)).toBe("open");
    expect(openingState(NINE_TO_SIX, "Europe/London", MONDAY_0530_UTC)).toBe("closed");
  });

  it("never says closed for an organisation that has not said when it is", () => {
    expect(openingState(null, "Europe/London", MONDAY_0530_UTC)).toBe("unset");
  });

  it("treats a day with no range as closed all day", () => {
    // Sunday 2026-09-06, midday in London.
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-06T11:00:00Z"))).toBe(
      "closed",
    );
    // Saturday morning is inside the short range; Saturday afternoon is not.
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-05T09:00:00Z"))).toBe(
      "open",
    );
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-05T13:00:00Z"))).toBe(
      "closed",
    );
  });

  it("opens at the opening minute and is closed at the closing minute", () => {
    // 09:00 BST is 08:00 UTC in September.
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-07T08:00:00Z"))).toBe(
      "open",
    );
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-07T07:59:00Z"))).toBe(
      "closed",
    );
    // 18:00 BST is 17:00 UTC: "we close at six" means closed at six.
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-07T17:00:00Z"))).toBe(
      "closed",
    );
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-09-07T16:59:00Z"))).toBe(
      "open",
    );
  });

  /**
   * British Summer Time ends on 2026-10-25. The same UTC instant is 17:30 on
   * the Saturday before (BST) and 16:30 on the Monday after (GMT); a table
   * of offsets would get one of them wrong, and `Intl` gets both right.
   */
  it("follows the clocks changing", () => {
    // Friday 2026-10-23, 16:30 UTC = 17:30 BST → closed (Friday closes at 18:00? no: open).
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-10-23T16:30:00Z"))).toBe(
      "open",
    );
    // Friday 2026-10-23, 17:30 UTC = 18:30 BST → closed.
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-10-23T17:30:00Z"))).toBe(
      "closed",
    );
    // Monday 2026-10-26, 17:30 UTC = 17:30 GMT → still open.
    expect(openingState(NINE_TO_SIX, "Europe/London", new Date("2026-10-26T17:30:00Z"))).toBe(
      "open",
    );
  });

  it("answers unset, never throws, for a zone the runtime does not know", () => {
    expect(openingState(NINE_TO_SIX, "Mars/Olympus_Mons", MONDAY_0530_UTC)).toBe("unset");
  });

  it("reads the weekday in the zone too, not in UTC", () => {
    // Sunday 2026-09-06 23:30 UTC is already Monday 03:30 in Dubai (closed,
    // before opening) and still Sunday in London (closed all day) — both
    // closed, but for different reasons. Two hours later Dubai is open.
    const lateSunday = new Date("2026-09-06T23:30:00Z");
    expect(openingState(NINE_TO_SIX, "Asia/Dubai", lateSunday)).toBe("closed");
    expect(openingState(NINE_TO_SIX, "Asia/Dubai", new Date("2026-09-07T05:30:00Z"))).toBe("open");
    // And Sunday 2026-09-06 04:00 UTC is Saturday 21:00 in Los Angeles.
    expect(openingState(NINE_TO_SIX, "America/Los_Angeles", new Date("2026-09-06T04:00:00Z"))).toBe(
      "closed",
    );
    expect(openingState(NINE_TO_SIX, "America/Los_Angeles", new Date("2026-09-05T17:00:00Z"))).toBe(
      "open",
    ); // Saturday 10:00 in LA
  });
});

describe("parseBusinessHours", () => {
  it("returns the shape when the column holds it", () => {
    expect(parseBusinessHours(NINE_TO_SIX)).toEqual(NINE_TO_SIX);
  });

  it("is null for nothing, and for anything that is not the shape", () => {
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours(undefined)).toBeNull();
    expect(parseBusinessHours({ mon: { open: "09:00", close: "18:00" } })).toBeNull();
    expect(
      parseBusinessHours({ ...NINE_TO_SIX, mon: { open: "18:00", close: "09:00" } }),
    ).toBeNull();
    expect(parseBusinessHours("09:00-18:00")).toBeNull();
  });
});
