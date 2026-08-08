import { describe, expect, it } from "vitest";
import {
  buildReminderMessage,
  type EmailReminderStepKey,
  type ReminderMessageInput,
} from "../src/modules/reminders/reminder-message.js";

/**
 * The reminder copy (Slice 1.7).
 *
 * These assert PROPERTIES, not strings. Pinning the exact prose would make the
 * suite fail every time the founder reworded a sentence, which is the one thing
 * we want to stay cheap — the words are expected to change once they have been
 * seen against a real invoice. What must not change is that the figure is the
 * balance, the currency is named, the tone ladder climbs, and the last email
 * tells the truth about being the last.
 */

const EMAIL_STAGES: EmailReminderStepKey[] = [
  "pre_due_3",
  "due_date",
  "overdue_7",
  "overdue_14",
  "overdue_30",
];

function input(overrides: Partial<ReminderMessageInput> = {}): ReminderMessageInput {
  return {
    stepKey: "overdue_7",
    invoiceReference: "INV-1001",
    dueDate: new Date("2026-08-12T00:00:00.000Z"),
    currency: "GBP",
    amountMinorUnits: 125_000n,
    amountPaidMinorUnits: 0n,
    daysOverdue: 7,
    contactName: "Sarah",
    organisationName: "Acme Ltd",
    ...overrides,
  };
}

describe("reminder message (Slice 1.7)", () => {
  describe("every stage produces a usable email", () => {
    for (const stepKey of EMAIL_STAGES) {
      it(`${stepKey} has a non-empty subject and body, names the invoice and signs off`, () => {
        const message = buildReminderMessage(input({ stepKey }));

        expect(message.subject.length).toBeGreaterThan(0);
        expect(message.bodyText.length).toBeGreaterThan(0);
        expect(message.subject).toContain("INV-1001");
        expect(message.bodyText).toContain("INV-1001");
        // Signed as the organisation — Eva never signs its own name.
        expect(message.bodyText).toContain("Acme Ltd");
        expect(message.bodyText).not.toContain("Eva");
      });
    }
  });

  /**
   * The anti-Zoho assertion. If placeholder syntax ever appears in the output
   * it means someone has reintroduced a template engine, which is the thing
   * the founder switched off (DATA-MODEL-REVIEW §8).
   */
  it("never emits template placeholder syntax", () => {
    for (const stepKey of EMAIL_STAGES) {
      const message = buildReminderMessage(input({ stepKey }));
      const whole = `${message.subject}\n${message.bodyText}`;
      expect(whole).not.toMatch(/\{\{|\}\}|\$\{/);
    }
  });

  describe("the figure quoted is the BALANCE, never the face value", () => {
    it("chases only what is still owed on a part-paid invoice", () => {
      const message = buildReminderMessage(
        input({ amountMinorUnits: 125_000n, amountPaidMinorUnits: 50_000n }),
      );

      // 1250.00 invoiced, 500.00 paid, 750.00 owed.
      expect(message.bodyText).toContain("GBP 750.00");
      // The face value must not be the sum being chased.
      expect(message.bodyText).not.toMatch(/due on .*GBP 1250\.00/);
    });

    it("thanks the customer for a part payment by amount", () => {
      const message = buildReminderMessage(
        input({ amountMinorUnits: 125_000n, amountPaidMinorUnits: 50_000n }),
      );

      expect(message.bodyText).toContain("Thank you for the GBP 500.00 already paid");
    });

    it("says nothing about payments when none has been made", () => {
      const message = buildReminderMessage(input({ amountPaidMinorUnits: 0n }));
      expect(message.bodyText).not.toContain("already paid");
    });

    /** Overpayment is allowed (§0d) and the balance clamps at zero. */
    it("does not thank or quote a negative balance when overpaid", () => {
      const message = buildReminderMessage(
        input({ amountMinorUnits: 125_000n, amountPaidMinorUnits: 130_000n }),
      );

      expect(message.bodyText).not.toContain("already paid");
      // Not a bare "-": the invoice reference legitimately contains a hyphen.
      // What must never appear is a NEGATIVE sum of money.
      expect(message.bodyText).not.toMatch(/GBP\s-/);
      expect(message.bodyText).toContain("GBP 0.00");
    });
  });

  describe("currency is always named, at the currency's own precision", () => {
    it("names the ISO code rather than assuming a symbol", () => {
      const message = buildReminderMessage(input({ currency: "AED" }));
      expect(message.bodyText).toContain("AED 1250.00");
      expect(message.bodyText).not.toContain("£");
    });

    /** KWD/BHD/OMR carry THREE decimal places — the fils trap (§0d). */
    it("renders a 3-decimal currency with all three digits", () => {
      const message = buildReminderMessage(
        input({ currency: "KWD", amountMinorUnits: 4_750_499n }),
      );
      expect(message.bodyText).toContain("KWD 4750.499");
    });

    /** JPY/KRW/VND have NO minor unit — a decimal point would be wrong. */
    it("renders a 0-decimal currency with no decimal point", () => {
      const message = buildReminderMessage(input({ currency: "JPY", amountMinorUnits: 50_000n }));
      expect(message.bodyText).toContain("JPY 50000");
      expect(message.bodyText).not.toContain("50000.");
    });
  });

  describe("the due date is the org-local day, not a timezone-shifted one", () => {
    it("formats the UTC-midnight due date as that calendar day", () => {
      const message = buildReminderMessage(
        input({ dueDate: new Date("2026-08-12T00:00:00.000Z") }),
      );
      expect(message.bodyText).toContain("12 August 2026");
      expect(message.bodyText).not.toContain("11 August");
    });
  });

  describe("the day count comes from the caller, not from the stage name", () => {
    /**
     * Offsets are configurable per organisation, so `overdue_30` may fire at
     * +45. The email must report the real number or it tells the customer a
     * lie about their own account.
     */
    it("reports the supplied daysOverdue even when it disagrees with the stage key", () => {
      const message = buildReminderMessage(input({ stepKey: "overdue_30", daysOverdue: 45 }));
      expect(message.subject).toContain("45");
      expect(message.subject).not.toContain("30 days");
    });

    it("never reports a negative day count before the due date", () => {
      const message = buildReminderMessage(input({ stepKey: "pre_due_3", daysOverdue: -3 }));
      expect(message.subject).not.toContain("-3");
      expect(message.bodyText).not.toContain("-3 days");
    });
  });

  /**
   * Slice 1.8b. A reminder is scheduled in advance and sent later, and three
   * things can move it: the catch-up collapse, the 3-day spacing pass deferring
   * it forward, and a due date edited after the fact. Only `pre_due_3` and
   * `due_date` make a claim about the future, so only those two can be made
   * FALSE by arriving late — and `due_date` is the serious one, because
   * "is due today" about a week-old debt is not a tone problem, it is a lie
   * that costs the sender credibility with their own client.
   */
  describe("a reminder that arrives after the due date never claims otherwise", () => {
    it("never tells a customer an overdue invoice is due today", () => {
      const message = buildReminderMessage(input({ stepKey: "due_date", daysOverdue: 7 }));
      expect(message.subject).not.toContain("due today");
      expect(message.bodyText).not.toContain("due today");
    });

    it("never sends the pre-due courtesy note once the invoice is late", () => {
      const message = buildReminderMessage(input({ stepKey: "pre_due_3", daysOverdue: 3 }));
      expect(message.bodyText).not.toContain("nothing to do");
      expect(message.subject).not.toContain("is due on");
    });

    it("uses the gentlest chase register instead, counting from the real date", () => {
      for (const stepKey of ["pre_due_3", "due_date"] as const) {
        const message = buildReminderMessage(input({ stepKey, daysOverdue: 5 }));
        expect(message.subject).toContain("5 days overdue");
        // Still the FIRST chase — assumes good faith, invites a reply. A late
        // `due_date` must not arrive sounding like the final notice.
        expect(message.bodyText).toContain("reply");
        expect(message.bodyText).not.toContain("last automatic reminder");
      }
    });

    /**
     * ⚠️ THE OTHER HALF, AND THE EASIER ONE TO BREAK. Widening the guard to
     * "always chase" would delete the pre-due nudge entirely — the stage the
     * founder specifically asked to keep first.
     */
    it("still sends the real pre-due and due-date copy when they are on time", () => {
      const preDue = buildReminderMessage(input({ stepKey: "pre_due_3", daysOverdue: -3 }));
      expect(preDue.bodyText).toContain("nothing to do");

      const onDue = buildReminderMessage(input({ stepKey: "due_date", daysOverdue: 0 }));
      expect(onDue.subject).toContain("due today");
    });

    it("counts a single day in the singular", () => {
      const message = buildReminderMessage(input({ stepKey: "overdue_7", daysOverdue: 1 }));
      expect(message.subject).toContain("1 day overdue");
      expect(message.subject).not.toContain("1 days");
      expect(message.bodyText).not.toContain("1 days");
    });
  });

  describe("the tone ladder climbs, and the last rung is honest", () => {
    it("the pre-due note tells the customer there is nothing to do", () => {
      const message = buildReminderMessage(input({ stepKey: "pre_due_3", daysOverdue: -3 }));
      expect(message.bodyText).toContain("nothing to do");
    });

    it("only the final email claims to be the final email", () => {
      const final = buildReminderMessage(input({ stepKey: "overdue_30", daysOverdue: 30 }));
      expect(final.subject).toContain("final reminder");
      expect(final.bodyText).toContain("last automatic reminder");

      for (const stepKey of EMAIL_STAGES.filter((k) => k !== "overdue_30")) {
        const earlier = buildReminderMessage(input({ stepKey, daysOverdue: 7 }));
        expect(earlier.bodyText).not.toContain("last automatic reminder");
        expect(earlier.subject).not.toContain("final reminder");
      }
    });

    /**
     * "We are not debt collectors" (founder, 2026-08-07). Eva has no authority
     * to threaten a fee, a lawyer or a credit file, so it must never imply one.
     */
    it("never threatens legal action, late fees or credit consequences", () => {
      const forbidden =
        /legal action|solicitor|lawyer|court|debt collect|late fee|interest will|credit rating|credit file|final demand/i;
      for (const stepKey of EMAIL_STAGES) {
        const message = buildReminderMessage(input({ stepKey, daysOverdue: 30 }));
        expect(`${message.subject}\n${message.bodyText}`).not.toMatch(forbidden);
      }
    });
  });

  describe("the greeting", () => {
    it("uses the contact's name when there is one", () => {
      expect(buildReminderMessage(input({ contactName: "Sarah" })).bodyText).toContain("Hi Sarah,");
    });

    it("falls back to a neutral opener when the name is missing or blank", () => {
      expect(buildReminderMessage(input({ contactName: null })).bodyText).toContain("Hello,");
      expect(buildReminderMessage(input({ contactName: "   " })).bodyText).toContain("Hello,");
    });
  });

  /**
   * The internal handover must never be buildable as a customer email. This is
   * enforced by the type, so the guard we want is a COMPILE error — if this
   * @ts-expect-error ever stops erroring, the exclusion has been lost.
   */
  it("cannot be asked to build the internal escalation as an email", () => {
    // @ts-expect-error final_escalation is not an EmailReminderStepKey
    const rejected: EmailReminderStepKey = "final_escalation";
    expect(rejected).toBe("final_escalation");
  });
});
