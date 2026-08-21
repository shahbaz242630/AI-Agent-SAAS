import { describe, expect, it } from "vitest";
import {
  CORRECTION_REASON_MIN,
  channelLabel,
  correctionReasonRefusal,
  doNotContactCountLine,
  recordedByLine,
  suppressionReasonLine,
} from "@/lib/do-not-contact";

describe("how a do-not-contact entry reads", () => {
  it("names the channel in a customer's words, not the database's", () => {
    expect(channelLabel("email")).toBe("Email address");
    expect(channelLabel("call")).toBe("Phone number");
  });

  /**
   * ⚠️ `whatsapp` ARRIVES IN PHASE 3 AND A WEB DEPLOY TRAILS AN API DEPLOY BY
   * MINUTES. For that window this build has never heard of the channel, and a
   * raw database word on a customer's screen is the same defect as "modules"
   * leaking onto the sidebar.
   */
  it("turns a channel it has never heard of into English", () => {
    expect(channelLabel("whatsapp")).toBe("Whatsapp");
  });

  /**
   * ⚠️ `lead_requested` IS WHAT `doNotContact` WRITES, AND IT MUST NEVER BE
   * PRINTED. It is the only reason the product currently stores, so this is not
   * a hypothetical: every entry made through the enquiry book carries it.
   */
  it("never prints the stored reason code at a customer", () => {
    expect(suppressionReasonLine("lead_requested")).toBe("They asked not to be contacted again.");
  });

  it("passes a human-written reason through untouched", () => {
    expect(suppressionReasonLine("They rang and asked us to stop")).toBe(
      "They rang and asked us to stop",
    );
  });

  it("says so plainly when no reason was recorded", () => {
    expect(suppressionReasonLine(null)).toBe("No reason was recorded.");
    expect(suppressionReasonLine("   ")).toBe("No reason was recorded.");
  });

  /**
   * ⚠️ NOT "UNKNOWN". A name is missing because that person has left the
   * organisation — `users` is readable as "yourself plus this tenant's members"
   * — and "unknown" reads as data loss on a compliance record.
   */
  it("explains a missing name rather than calling it unknown", () => {
    expect(recordedByLine(null)).toBe("someone who has since left");
    expect(recordedByLine("Priya Raman")).toBe("Priya Raman");
  });

  it("counts people the way a person would", () => {
    expect(doNotContactCountLine(0)).toBe("Nobody is on this list.");
    expect(doNotContactCountLine(1)).toBe("1 person Eva will not contact.");
    expect(doNotContactCountLine(4)).toBe("4 people Eva will not contact.");
  });
});

/**
 * ⚠️ THIS IS THE ONLY THING STANDING BETWEEN A MIS-CLICK AND AN UNEXPLAINED
 * UNDO. The API and a CHECK constraint enforce the same minimum; this copy
 * exists so somebody is refused before a round trip, never so the screen can be
 * more lenient than the API.
 */
describe("whether a stated reason is enough", () => {
  it("refuses an empty reason", () => {
    expect(correctionReasonRefusal("")).toBe("Say why this was recorded in error.");
    expect(correctionReasonRefusal("    ")).toBe("Say why this was recorded in error.");
  });

  it("refuses one word, because a year from now it answers nothing", () => {
    expect(correctionReasonRefusal("mistake")).toContain("a bit more detail");
    expect(correctionReasonRefusal("oops")).toContain("a bit more detail");
  });

  it("accepts a real explanation", () => {
    expect(correctionReasonRefusal("Clicked it on the wrong enquiry")).toBeNull();
  });

  /** Whitespace must not buy somebody past the minimum. */
  it("measures the trimmed sentence, not the padding", () => {
    expect(correctionReasonRefusal(`  ${"a".repeat(CORRECTION_REASON_MIN - 1)}      `)).toContain(
      "a bit more detail",
    );
    expect(correctionReasonRefusal("a".repeat(CORRECTION_REASON_MIN))).toBeNull();
  });
});
