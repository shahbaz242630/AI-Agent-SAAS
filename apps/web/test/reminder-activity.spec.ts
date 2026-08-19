import { describe, expect, it } from "vitest";
import { REMINDER_STEP_KEYS, SCHEDULED_ACTION_STATUSES } from "@eva/types";
import {
  describeNoHistoryYet,
  explainWaiting,
  stageLabel,
  statusLabel,
  statusTone,
} from "@/products/invoice-follow-up/reminder-activity";

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

  /**
   * ⚠️ `summarise` USED TO LIVE HERE AND WAS DEAD CODE. It was a second,
   * unused copy of `chaseSummary` in `products/invoice-follow-up/dashboard.ts` — same sentences, no
   * caller in `src`, covered only by its own tests. Two functions for one job
   * is how the product ends up saying two things; it was deleted rather than
   * updated alongside the live one. Its coverage lives in `dashboard.spec.ts`.
   */
  describe("what to say before Eva has written to anybody", () => {
    /** Dates arrive already resolved in the org's timezone. */
    const asGiven = (isoDate: string) => isoDate;

    /**
     * A new customer with no overdue invoices is the HEALTHIEST state there is.
     * It must not read as though something has gone wrong.
     */
    it("treats a book with nothing to chase as normal, not as a problem", () => {
      const state = describeNoHistoryYet({
        scheduled: 0,
        noWorkingMailbox: false,
        nextDate: null,
        formatDate: asGiven,
      });

      expect(state.detail).toContain("has not needed to write to anybody");
      expect(state.detail.toLowerCase()).not.toContain("error");
      expect(state.detail.toLowerCase()).not.toContain("problem");
    });

    /**
     * ⚠️ THE DEFECT THIS FUNCTION EXISTS FOR (found by walking, 2026-08-18).
     * The old copy claimed "Eva simply has not needed to write to anybody"
     * unconditionally, while six reminders sat scheduled for an invoice worth
     * £45,711. "Has not needed to" and "is not due yet" are different claims.
     */
    it("never says Eva has not needed to write when reminders are scheduled", () => {
      const state = describeNoHistoryYet({
        scheduled: 6,
        noWorkingMailbox: false,
        nextDate: "2026-09-15",
        formatDate: asGiven,
      });

      expect(state.detail).not.toContain("has not needed to write");
      expect(state.detail).toContain("2026-09-15");
      expect(state.detail).toContain("6 reminders are");
    });

    it("counts one scheduled reminder as one", () => {
      const state = describeNoHistoryYet({
        scheduled: 1,
        noWorkingMailbox: false,
        nextDate: "2026-09-15",
        formatDate: asGiven,
      });
      expect(state.detail).toContain("1 reminder is");
    });

    /**
     * ⚠️ A DATE WE CANNOT KEEP IS WORSE THAN NO DATE. Promising a send from an
     * organisation with no mailbox is the upload-preview defect wearing a
     * different hat: the screen stating an outcome that will not happen.
     */
    it("leads with the missing mailbox rather than the promise", () => {
      const state = describeNoHistoryYet({
        scheduled: 6,
        noWorkingMailbox: true,
        nextDate: "2026-09-15",
        formatDate: asGiven,
      });

      expect(state.headline).toContain("nowhere to send from");
      expect(state.detail).toContain("no mailbox is connected");
      // Still says nothing is lost — the fix is one click and the plan survives.
      expect(state.detail).toContain("Nothing is lost");
    });

    /**
     * A count with no date to attach it to would read as a broken sentence.
     * Falling back is safer than printing "starting on null".
     */
    it("falls back to the plain copy when a count arrives with no date", () => {
      const state = describeNoHistoryYet({
        scheduled: 4,
        noWorkingMailbox: false,
        nextDate: null,
        formatDate: asGiven,
      });
      expect(state.headline).toBe("Nothing to show yet.");
    });
  });
});
