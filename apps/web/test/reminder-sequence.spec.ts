import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_STEPS, REMINDER_STEP_KEYS } from "@eva/types";
import { updateReminderStepSchema } from "@eva/validation";
import {
  MAX_OFFSET_DAYS,
  MIN_DAYS_BETWEEN_REMINDERS,
  MIN_OFFSET_DAYS,
  describeDisabling,
  describeOffset,
  isHandover,
  splitOffset,
  stepPurpose,
  toOffsetDays,
  validateOffset,
} from "@/lib/reminder-sequence";

/**
 * The reminder-timing screen (Slice 1.8).
 *
 * The sign conversion is the part worth pinning: `offsetDays` is negative for
 * "before the due date", the form never shows a minus sign, and getting it
 * backwards chases a customer three days EARLY instead of three days late —
 * which looks to their client like being hassled for money that is not yet owed.
 */
describe("reminder timing", () => {
  describe("sign conversion", () => {
    it("round-trips every default step through the form and back", () => {
      for (const step of DEFAULT_REMINDER_STEPS) {
        const parts = splitOffset(step.offsetDays);
        expect(toOffsetDays(parts.direction, parts.days)).toBe(step.offsetDays);
      }
    });

    it("puts pre_due_3 BEFORE the due date, not after", () => {
      const preDue = DEFAULT_REMINDER_STEPS.find((step) => step.key === "pre_due_3");
      expect(preDue?.offsetDays).toBe(-3);

      const parts = splitOffset(preDue!.offsetDays);
      expect(parts).toEqual({ direction: "before", days: 3 });
      expect(describeOffset(preDue!.offsetDays)).toBe("3 days before the due date");
    });

    /**
     * ⚠️ MUTATION GUARD. Dropping the negation in `toOffsetDays` leaves the
     * round-trip test above green for `due_date` (0 is its own negative), so
     * this asserts the direction survives independently.
     */
    it("never returns a positive offset for a reminder set before the due date", () => {
      for (let days = 1; days <= 30; days += 1) {
        expect(toOffsetDays("before", days)).toBeLessThan(0);
        expect(toOffsetDays("after", days)).toBeGreaterThan(0);
      }
    });

    it("treats zero days as the due date whichever direction is chosen", () => {
      expect(toOffsetDays("before", 0)).toBe(0);
      expect(toOffsetDays("after", 0)).toBe(0);
      expect(toOffsetDays("on", 7)).toBe(0);
    });
  });

  describe("descriptions", () => {
    it("says 'on the due date' rather than '0 days'", () => {
      expect(describeOffset(0)).toBe("On the due date");
    });

    it("uses the singular for one day", () => {
      expect(describeOffset(-1)).toBe("1 day before the due date");
      expect(describeOffset(1)).toBe("1 day after the due date");
    });

    it("never shows a customer a minus sign", () => {
      for (let offset = MIN_OFFSET_DAYS; offset <= MAX_OFFSET_DAYS; offset += 1) {
        expect(describeOffset(offset)).not.toContain("-");
      }
    });
  });

  describe("bounds", () => {
    /**
     * ⚠️ THE MIRROR TEST. These bounds are duplicated from the API's Zod schema
     * so the form can refuse without a round trip, and `apps/web`'s other mirror
     * of an API rule went stale within an hour. This compares the two directly:
     * widen the API and this fails until the browser is widened too.
     */
    it("matches the API's own accepted range exactly", () => {
      expect(updateReminderStepSchema.safeParse({ offsetDays: MIN_OFFSET_DAYS }).success).toBe(
        true,
      );
      expect(updateReminderStepSchema.safeParse({ offsetDays: MAX_OFFSET_DAYS }).success).toBe(
        true,
      );
      expect(updateReminderStepSchema.safeParse({ offsetDays: MIN_OFFSET_DAYS - 1 }).success).toBe(
        false,
      );
      expect(updateReminderStepSchema.safeParse({ offsetDays: MAX_OFFSET_DAYS + 1 }).success).toBe(
        false,
      );
    });

    it("refuses a timing further out than the API would accept", () => {
      expect(validateOffset("before", 31)).toContain("30 days before");
      expect(validateOffset("after", 91)).toContain("90 days after");
    });

    it("accepts both edges", () => {
      expect(validateOffset("before", 30)).toBeNull();
      expect(validateOffset("after", 90)).toBeNull();
      expect(validateOffset("on", 0)).toBeNull();
    });

    it("refuses a fraction and a negative, and says what to do instead", () => {
      expect(validateOffset("before", 2.5)).toContain("whole number");
      expect(validateOffset("before", -3)).toContain("minus sign");
    });

    it("keeps every default step inside the range a customer can set", () => {
      for (const step of DEFAULT_REMINDER_STEPS) {
        expect(step.offsetDays).toBeGreaterThanOrEqual(MIN_OFFSET_DAYS);
        expect(step.offsetDays).toBeLessThanOrEqual(MAX_OFFSET_DAYS);
      }
    });
  });

  describe("copy", () => {
    it("explains every stage, with no gaps and no raw keys", () => {
      for (const key of REMINDER_STEP_KEYS) {
        const purpose = stepPurpose(key);
        expect(purpose).toBeTruthy();
        expect(purpose).not.toBe("A reminder."); // the fallback — nothing should hit it
        expect(purpose).not.toContain("_");
      }
    });

    /**
     * The founder's ruling is the product: Eva chases a bounded number of times
     * and then hands over. If this screen ever describes the handover as
     * another email, a customer has been told Eva does something she does not.
     */
    it("never describes the handover as an email to the customer", () => {
      const purpose = stepPurpose("final_escalation").toLowerCase();
      expect(purpose).toContain("not an email");
      expect(isHandover("internal_escalation")).toBe(true);
      expect(isHandover("email")).toBe(false);
    });

    it("warns that switching off the handover leaves nobody told", () => {
      expect(describeDisabling("internal_escalation")).toContain("without telling anyone");
      expect(describeDisabling("email")).toContain("skips this stage");
    });

    it("states the spacing rule the scheduler actually enforces", () => {
      expect(MIN_DAYS_BETWEEN_REMINDERS).toBe(3);
    });
  });
});
