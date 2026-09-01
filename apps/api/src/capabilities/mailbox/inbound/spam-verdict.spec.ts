import { describe, expect, it } from "vitest";
import { readInboundVerdicts, refusalReason } from "./spam-verdict.js";

/**
 * The provider's verdict on an inbound message (slice 3.1c-0b, ruling 32).
 *
 * ⚠️ THE HEADER NAMES ARE REAL AND WERE READ OFF PRODUCTION, not copied from
 * documentation. On 2026-09-01 `inbound_messages.headers` on our own database
 * carried `x-ses-spam-verdict`, `x-ses-virus-verdict`, `received-spf` and
 * `dkim-signature` — the signal was arriving and being stored, and nothing had
 * ever read it.
 *
 * ⚠️ THE `GRAY` CASE IS THE MOST IMPORTANT TEST IN THIS FILE. It is SES saying
 * "probably spam, not certain", and it must go THROUGH. Ruling 32 is "err
 * toward silence; the uncertain middle waits for a human" — and a human only
 * sees it if it reaches the book. Refusing GRAY would silently bin real
 * enquiries, which is a lost customer nobody ever finds out about.
 */
describe("readInboundVerdicts", () => {
  it("reads both verdicts", () => {
    expect(
      readInboundVerdicts({ "x-ses-spam-verdict": "PASS", "x-ses-virus-verdict": "FAIL" }),
    ).toEqual({ spam: "PASS", virus: "FAIL" });
  });

  it("is case-insensitive about the header name and the value", () => {
    expect(readInboundVerdicts({ "X-SES-Spam-Verdict": "fail" }).spam).toBe("FAIL");
  });

  /** An absent verdict is UNKNOWN, never a silent PASS or FAIL. */
  it("reports a missing header as UNKNOWN", () => {
    expect(readInboundVerdicts({})).toEqual({ spam: "UNKNOWN", virus: "UNKNOWN" });
  });

  it("reports a value it does not recognise as UNKNOWN", () => {
    expect(readInboundVerdicts({ "x-ses-spam-verdict": "banana" }).spam).toBe("UNKNOWN");
  });
});

describe("refusalReason", () => {
  it("refuses a message the provider judged spam", () => {
    expect(refusalReason({ "x-ses-spam-verdict": "FAIL" })).toContain("spam");
  });

  /** Malware gets its OWN sentence, so somebody asking "where did that go?" is
   *  told the real reason rather than a generic "we thought it was junk". */
  it("refuses malware, and says so distinctly", () => {
    const reason = refusalReason({ "x-ses-virus-verdict": "FAIL" });
    expect(reason).toContain("malware");
    expect(reason).not.toContain("spam");
  });

  it("names malware first when a message is both", () => {
    const reason = refusalReason({
      "x-ses-spam-verdict": "FAIL",
      "x-ses-virus-verdict": "FAIL",
    });
    expect(reason).toContain("malware");
  });

  it("lets a clean message through", () => {
    expect(
      refusalReason({ "x-ses-spam-verdict": "PASS", "x-ses-virus-verdict": "PASS" }),
    ).toBeNull();
  });

  /**
   * ⚠️ THE UNCERTAIN MIDDLE GOES THROUGH — ruling 32. These three are the whole
   * safety argument: if any of them ever starts refusing, real enquiries begin
   * disappearing with nothing failing anywhere to say so.
   */
  it.each([["GRAY"], ["PROCESSING_FAILED"], ["banana"]])(
    "lets a '%s' spam verdict through for a human to judge",
    (verdict) => {
      expect(refusalReason({ "x-ses-spam-verdict": verdict })).toBeNull();
    },
  );

  it("lets a message with no verdict headers at all through", () => {
    expect(refusalReason({})).toBeNull();
  });
});
