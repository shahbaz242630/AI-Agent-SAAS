import { describe, expect, it } from "vitest";
import {
  bookCountLine,
  contactLine,
  describeMoment,
  evidenceSummary,
  leadName,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
  nowForInput,
  wallClockToInstant,
} from "@/products/lead-follow-up/lead-book";

describe("lead vocabulary", () => {
  it("says each manual source the way a person would", () => {
    expect(leadSourceLabel("missed_call")).toBe("Missed call");
    expect(leadSourceLabel("existing_customer")).toBe("Existing client");
    expect(leadSourceLabel("callback_request")).toBe("Callback request");
  });

  /**
   * ⚠️ THE WINDOW THIS COVERS IS REAL AND ARRIVES AT 3.1b. The API starts
   * writing `email_enquiry` the moment Eva can read a mailbox, and web deploys
   * trail api deploys by minutes. For that window this build has never heard of
   * the value — and a raw database word on a customer's screen is the same
   * defect as "modules" leaking onto the sidebar.
   */
  it("turns a source it has never heard of into English", () => {
    expect(leadSourceLabel("email_enquiry")).toBe("Email enquiry");
    expect(leadSourceLabel("website_form")).toBe("Website form");
    expect(leadSourceLabel("")).toBe("Enquiry");
  });

  it("names the two states and how loud each is", () => {
    expect(leadStatusLabel("new")).toBe("New");
    expect(leadStatusLabel("do_not_contact")).toBe("Do not contact");
    expect(leadStatusTone("do_not_contact")).toBe("bad");
    expect(leadStatusTone("new")).toBe("mute");
  });
});

describe("how to reach them", () => {
  it("shows both ways when both are known", () => {
    expect(contactLine({ contactEmail: "sam@example.com", contactPhone: "07700 900123" })).toBe(
      "sam@example.com · 07700 900123",
    );
  });

  it("shows whichever one there is", () => {
    expect(contactLine({ contactEmail: null, contactPhone: "07700 900123" })).toBe("07700 900123");
    expect(contactLine({ contactEmail: "sam@example.com", contactPhone: null })).toBe(
      "sam@example.com",
    );
  });

  /**
   * The API and a CHECK constraint both refuse a lead with neither, so this is
   * the impossible case — and it still must not render an empty cell, which
   * reads as a broken screen rather than as missing data.
   */
  it("says so rather than printing nothing", () => {
    expect(contactLine({ contactEmail: null, contactPhone: null })).toBe("No contact details");
    expect(contactLine({ contactEmail: "  ", contactPhone: "" })).toBe("No contact details");
  });

  it("stands in for a missing name", () => {
    expect(leadName({ contactName: "Sam Okafor" })).toBe("Sam Okafor");
    expect(leadName({ contactName: "   " })).toBe("Someone who didn't leave a name");
    expect(leadName({ contactName: null })).toBe("Someone who didn't leave a name");
  });
});

describe("the count line", () => {
  it("counts in words a person would use", () => {
    expect(bookCountLine(0)).toBe("No enquiries yet.");
    expect(bookCountLine(1)).toBe("1 enquiry.");
    expect(bookCountLine(12)).toBe("12 enquiries.");
  });
});

describe("the evidence sentence", () => {
  it("answers why contacting them is lawful, not just what happened", () => {
    const line = evidenceSummary(
      { channel: "missed_call", occurredAt: "2026-08-19T13:30:00.000Z" },
      "Europe/London",
    );
    expect(line).toContain("They got in touch themselves");
    expect(line).toContain("missed call");
    expect(line).toContain("lawful");
  });

  /**
   * ⚠️ NO EVIDENCE MUST READ AS A STOP, NOT AS A BLANK. The lead and its
   * evidence are written in one transaction precisely so this cannot happen —
   * but if it ever does, the screen has to say Eva will not act, because the
   * BRD's rule is that an unevidenced lead never enters the queue.
   */
  it("says Eva will not act when there is no evidence", () => {
    const line = evidenceSummary(null, "Europe/London");
    expect(line).toContain("will not contact");
  });
});

describe("moments, in the organisation's timezone", () => {
  it("reads a British summer afternoon as the customer's clock, not the server's", () => {
    // 13:30 UTC in August is 14:30 in London (BST).
    expect(describeMoment("2026-08-19T13:30:00.000Z", "Europe/London")).toBe(
      "Wednesday 19 August at 2:30pm",
    );
  });

  it("moves the same instant for a customer in another zone", () => {
    expect(describeMoment("2026-08-19T13:30:00.000Z", "Asia/Dubai")).toBe(
      "Wednesday 19 August at 5:30pm",
    );
  });

  it("does not lose the screen to a bad timezone or a bad date", () => {
    expect(describeMoment("2026-08-19T13:30:00.000Z", "Mars/Olympus")).toContain("19 August");
    expect(describeMoment("not-a-date", "Europe/London")).toBe("at an unknown time");
  });
});

/**
 * ⚠️ THIS IS THE ONE THAT WOULD HAVE SHIPPED WRONG AND LOOKED FINE.
 *
 * A `datetime-local` box hands back wall-clock digits with no zone attached.
 * Our compute runs in `us-west2`, eight hours behind London, so letting the
 * server parse them files a 9am enquiry at 5pm — and speed-to-lead, the number
 * this whole product is judged on, is measured from exactly this field.
 */
describe("what somebody typed into the date box", () => {
  it("reads the digits as the organisation's clock, not the server's", () => {
    // 14:30 in London during BST is 13:30 UTC.
    expect(wallClockToInstant("2026-08-20T14:30", "Europe/London")).toBe(
      "2026-08-20T13:30:00.000Z",
    );
  });

  it("handles a zone ahead of UTC", () => {
    // 14:30 in Dubai (UTC+4) is 10:30 UTC.
    expect(wallClockToInstant("2026-08-20T14:30", "Asia/Dubai")).toBe("2026-08-20T10:30:00.000Z");
  });

  it("handles a zone behind UTC", () => {
    // 14:30 in New York during EDT (UTC-4) is 18:30 UTC.
    expect(wallClockToInstant("2026-08-20T14:30", "America/New_York")).toBe(
      "2026-08-20T18:30:00.000Z",
    );
  });

  /** London is UTC+0 in January and UTC+1 in July, and both must be right. */
  it("is right on both sides of a daylight-saving change", () => {
    expect(wallClockToInstant("2026-01-15T09:00", "Europe/London")).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    expect(wallClockToInstant("2026-07-15T09:00", "Europe/London")).toBe(
      "2026-07-15T08:00:00.000Z",
    );
  });

  /**
   * ⚠️ THIS IS THE ONE THAT COVERS THE SECOND CORRECTION PASS, AND IT WAS
   * MISSING. The two tests above pass with a single pass too — I checked by
   * cutting the loop and watching all 23 stay green, which means the comment
   * claiming two passes were needed "across a DST boundary" was decoration.
   *
   * The pass is only load-bearing in the spring-forward GAP. London jumps
   * 01:00 → 02:00 on 29 March 2026, so 01:30 is a time that does not exist —
   * somebody picked it from a date box that does not know that. One pass files
   * it at 00:30 local, an hour EARLIER than typed, which would date an enquiry
   * before it arrived. Two passes push it forward to 02:30 local.
   */
  it("pushes a time that does not exist forward, never backward", () => {
    // 01:30 on 29 March 2026 never happens in London. 01:30Z is 02:30 BST.
    expect(wallClockToInstant("2026-03-29T01:30", "Europe/London")).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(describeMoment("2026-03-29T01:30:00.000Z", "Europe/London")).toBe(
      "Sunday 29 March at 2:30am",
    );
  });

  /** The autumn repeat — 01:30 happens twice — resolves to the first of them. */
  it("settles on one answer when a time happens twice", () => {
    expect(wallClockToInstant("2026-10-25T01:30", "Europe/London")).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it("refuses what it cannot read rather than inventing a date", () => {
    expect(wallClockToInstant("", "Europe/London")).toBeNull();
    expect(wallClockToInstant("yesterday", "Europe/London")).toBeNull();
    expect(wallClockToInstant("20/08/2026 14:30", "Europe/London")).toBeNull();
  });

  it("keeps what was typed even when the zone is nonsense", () => {
    expect(wallClockToInstant("2026-08-20T14:30", "Mars/Olympus")).toBe("2026-08-20T14:30:00.000Z");
  });

  /** The round trip is the property that matters: what they typed is what the
   *  screen shows back to them afterwards. */
  it("survives a round trip through the screen's own formatter", () => {
    const instant = wallClockToInstant("2026-08-20T14:30", "Europe/London");
    expect(describeMoment(instant!, "Europe/London")).toBe("Thursday 20 August at 2:30pm");
  });
});

describe("the date box's starting value", () => {
  it("opens on the customer's clock, not UTC", () => {
    const at = new Date("2026-08-20T13:30:00.000Z");
    expect(nowForInput("Europe/London", at)).toBe("2026-08-20T14:30");
    expect(nowForInput("Asia/Dubai", at)).toBe("2026-08-20T17:30");
  });

  /** Midnight renders as hour 24 in some engines; it must not become "24:00",
   *  which every browser silently rejects, leaving the box empty. */
  it("writes midnight as 00, not 24", () => {
    expect(nowForInput("UTC", new Date("2026-08-20T00:15:00.000Z"))).toBe("2026-08-20T00:15");
  });

  it("produces a value the converter reads back unchanged", () => {
    const at = new Date("2026-08-20T13:30:00.000Z");
    const typed = nowForInput("Europe/London", at);
    expect(wallClockToInstant(typed, "Europe/London")).toBe("2026-08-20T13:30:00.000Z");
  });
});
