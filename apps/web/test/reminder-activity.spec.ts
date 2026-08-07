import { describe, expect, it } from "vitest";
import { REMINDER_STEP_KEYS, SCHEDULED_ACTION_STATUSES } from "@eva/types";
import {
  explainWaiting,
  stageLabel,
  statusLabel,
  statusTone,
  summarise,
} from "@/lib/reminder-activity";

/**
 * The chase activity screen's copy (Slice 1.7). These matter more than they
 * look: this is the only screen that tells a customer why Eva has not chased
 * anybody, and the wrong sentence sends them to fix a mailbox that is fine.
 */
describe("reminder activity copy", () => {
  describe("stage labels", () => {
    it("labels every stage the API can send, with no gaps", () => {
      for (const key of REMINDER_STEP_KEYS) {
        const label = stageLabel(key);
        expect(label).toBeTruthy();
        expect(label).not.toBe("Reminder"); // the fallback — no stage should hit it
        expect(label).not.toContain("_"); // never leak the raw key
      }
    });
  });

  describe("status labels", () => {
    it("labels every status the lifecycle can produce", () => {
      for (const status of SCHEDULED_ACTION_STATUSES) {
        const label = statusLabel(status);
        expect(label).toBeTruthy();
        expect(label).not.toBe("Unknown");
        expect(label).not.toContain("_");
      }
    });

    /**
     * By the time a row reaches this screen it is DUE. Calling that "Ready"
     * would tell a customer everything is fine while nothing is going out.
     */
    it("calls a due-but-unsent reminder 'Waiting', not 'Ready'", () => {
      expect(statusLabel("ready")).toBe("Waiting");
    });

    it("tones sent as good, waiting as warning and failed as bad", () => {
      expect(statusTone("sent")).toBe("good");
      expect(statusTone("ready")).toBe("warn");
      expect(statusTone("failed")).toBe("bad");
    });
  });

  describe("explaining why nothing has gone out", () => {
    it("says nothing when nothing is waiting", () => {
      expect(explainWaiting(0, null)).toBeNull();
      expect(explainWaiting(0, "no_working_mailbox")).toBeNull();
    });

    it("names the mailbox as the cause, and links to the fix", () => {
      const explanation = explainWaiting(3, "no_working_mailbox");

      expect(explanation?.headline).toContain("3 reminders are waiting");
      expect(explanation?.headline).toContain("no mailbox is connected");
      expect(explanation?.fixHref).toBe("/app/settings/mailbox");
      expect(explanation?.fixLabel).toBeTruthy();
    });

    /**
     * ⚠️ Eva cannot always tell why. Inventing a confident cause would send a
     * customer to fix a mailbox that is working perfectly.
     */
    it("does NOT blame the mailbox when the cause is unknown", () => {
      const explanation = explainWaiting(2, "unknown");

      expect(explanation?.headline).toContain("2 reminders are waiting");
      expect(explanation?.headline).not.toContain("mailbox");
      expect(explanation?.detail).not.toContain("mailbox");
      expect(explanation?.fixHref).toBeNull();
    });

    /** Whatever the cause, the customer must know the reminder is not lost. */
    it("always reassures that nothing has been lost", () => {
      for (const reason of ["no_working_mailbox", "unknown"] as const) {
        expect(explainWaiting(1, reason)?.detail).toContain("Nothing is lost");
      }
    });

    it("reads naturally for a single reminder", () => {
      expect(explainWaiting(1, "unknown")?.headline).toContain("1 reminder is waiting");
    });
  });

  describe("the summary line", () => {
    /**
     * A new customer with no overdue invoices is the HEALTHIEST state there is.
     * It must not read as though something has gone wrong.
     */
    it("treats an empty week as normal, not as a problem", () => {
      const summary = summarise({ sentLast7Days: 0, waiting: 0, failedLast7Days: 0 });

      expect(summary).toContain("hasn't needed to chase");
      expect(summary.toLowerCase()).not.toContain("error");
      expect(summary.toLowerCase()).not.toContain("problem");
      expect(summary.toLowerCase()).not.toContain("fail");
    });

    it("counts what went out", () => {
      expect(summarise({ sentLast7Days: 4, waiting: 0, failedLast7Days: 0 })).toContain(
        "4 reminders sent",
      );
      expect(summarise({ sentLast7Days: 1, waiting: 0, failedLast7Days: 0 })).toContain(
        "1 reminder sent",
      );
    });
  });
});
