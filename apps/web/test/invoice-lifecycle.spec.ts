import { describe, expect, it } from "vitest";
import type { InvoiceLifecycleAction } from "../src/lib/invoice-lifecycle";
import {
  availableInvoiceActions,
  invoiceActionConfirmLabel,
  invoiceActionConsequence,
  invoiceActionLabel,
  invoiceActionSuccess,
  isInvoiceActionIrreversible,
  isInvoiceLifecycleAction,
  storedStatusOf,
} from "../src/lib/invoice-lifecycle";

/**
 * The four lifecycle actions (slice 1.6c, task 4).
 *
 * Two things are being defended here, and only one of them is the table of
 * legal transitions. The other is the COPY: every sentence in this module is a
 * promise about what happens to somebody's debtor, and the assertions below are
 * about what the promises must not say — that a pause holds the queued
 * reminders (it cancels them), that a resume continues where it stopped (it
 * starts fresh), or that a cancel could be undone (it cannot).
 */

const ALL: InvoiceLifecycleAction[] = ["activate", "pause", "resume", "cancel"];

const invoice = { invoiceNumber: "INV-1001", hasRecipient: true };

describe("availableInvoiceActions — a mirror of the API's state machine", () => {
  it("offers exactly what the state machine allows from each stored status", () => {
    expect(availableInvoiceActions("draft")).toEqual(["activate", "cancel"]);
    expect(availableInvoiceActions("active")).toEqual(["pause", "cancel"]);
    expect(availableInvoiceActions("paused")).toEqual(["resume", "cancel"]);
  });

  it("offers nothing from a resting status, including every outcome status", () => {
    // These have no API path at all until slice 1.8. A button for one would be
    // a promise the product cannot keep.
    for (const status of [
      "cancelled",
      "paid",
      "partially_paid",
      "promise_to_pay",
      "disputed",
      "written_off",
    ]) {
      expect(availableInvoiceActions(status)).toEqual([]);
    }
  });

  /**
   * ⚠️ THE TRAP THIS MODULE EXISTS TO REMOVE.
   *
   * An overdue invoice is STORED as `active`; `overdue` is derived per request
   * from the org timezone and only ever appears on the badge. A screen that
   * asked for actions using the status it had just displayed would offer
   * nothing at all on precisely the invoices somebody most needs to pause or
   * cancel — and it would look deliberate rather than broken.
   */
  it("treats the three DERIVED statuses as the active invoices they are", () => {
    for (const derived of ["due_soon", "due_today", "overdue"]) {
      expect(storedStatusOf(derived)).toBe("active");
      expect(availableInvoiceActions(derived)).toEqual(availableInvoiceActions("active"));
    }
  });

  it("leaves a stored status alone", () => {
    for (const stored of ["draft", "active", "paused", "cancelled", "paid"]) {
      expect(storedStatusOf(stored)).toBe(stored);
    }
  });

  it("offers nothing for a status it has never heard of", () => {
    // The web app can be older than the API it is talking to — during a deploy
    // it demonstrably is. Guessing an action for an unknown status is how you
    // send a request that cannot succeed.
    expect(availableInvoiceActions("some_new_state")).toEqual([]);
    expect(availableInvoiceActions("")).toEqual([]);
  });
});

describe("isInvoiceLifecycleAction — the server action's own guard", () => {
  it("accepts the four and refuses anything else", () => {
    for (const action of ALL) expect(isInvoiceLifecycleAction(action)).toBe(true);
    // A server action is reachable by direct POST, and this string ends up in
    // an API path.
    for (const bogus of ["", "delete", "pay", "../../organisations", "ACTIVATE"]) {
      expect(isInvoiceLifecycleAction(bogus)).toBe(false);
    }
  });
});

describe("the consequence stated before the click", () => {
  it("names the invoice in every action, so a lingering message cannot be misread", () => {
    // The banner outlives the panel that produced it, deliberately. That is
    // only safe while every sentence says which invoice it is about.
    for (const action of ALL) {
      expect(invoiceActionConsequence(action, invoice)).toContain("INV-1001");
      expect(invoiceActionSuccess(action, "INV-1001", { hasRecipient: true })).toContain(
        "INV-1001",
      );
    }
  });

  it("says a pause CANCELS the queued reminders rather than holding them", () => {
    // `cancelInvoiceReminders` sets every pending/ready row to cancelled. A
    // sentence implying they are held would be the "right outcome, wrong
    // record" defect in the copy layer.
    const text = invoiceActionConsequence("pause", invoice);
    expect(text).toMatch(/cancelled rather than held/i);
    expect(text).not.toMatch(/held until|paused until|picks? up where/i);
  });

  it("says a resume starts a FRESH schedule from today", () => {
    // `recomputeInvoiceReminders` is cancel + reschedule, so nothing missed is
    // sent late — it collapses into one catch-up.
    const text = invoiceActionConsequence("resume", invoice);
    expect(text).toMatch(/fresh schedule/i);
    expect(text).toMatch(/not sent late|catch-up/i);
  });

  it("says a cancel cannot be undone, and is not a way to record payment", () => {
    // The state machine has no transition OUT of cancelled, in any direction.
    const text = invoiceActionConsequence("cancel", invoice);
    expect(text).toMatch(/cannot be undone/i);
    // Trap 7: until a payment can be recorded, cancelling is the only way to
    // stop a chase — which is exactly why this must not read as "settled".
    expect(text).toMatch(/not the same as paid/i);
  });

  it("does not promise chasing starts at the due date, because it starts before", () => {
    // DEFAULT_REMINDER_STEPS opens with pre_due_3: the client hears from Eva
    // three days BEFORE the money is late. Saying "from its due date" would
    // understate it in the direction that embarrasses a customer.
    const text = invoiceActionConsequence("activate", invoice);
    expect(text).toMatch(/three days before/i);
  });

  it("warns that starting a chase with no recipient chases nobody", () => {
    /**
     * ⚠️ THE SILENT CASE. `checkReminderEligibility` refuses an invoice with no
     * contact, so the transition succeeds, the badge says Active, and zero
     * reminders are scheduled. Proven on 2026-08-04: INV-5002 activated with no
     * contact and `scheduled_actions` stayed empty.
     *
     * ⚠️ RESUME TOO, not just activate. Both call the scheduler and both are
     * equally silent — treating this as an activation-only problem was the
     * first version's mistake.
     */
    for (const action of ["activate", "resume"] as const) {
      const text = invoiceActionConsequence(action, {
        invoiceNumber: "INV-1001",
        hasRecipient: false,
      });
      expect(text).toMatch(/nobody set to receive reminders/i);
      expect(text).toMatch(/nothing will be sent/i);
      // And it must NOT be the cheerful version.
      expect(text).not.toMatch(/will start chasing|fresh schedule/i);
    }
  });

  it("changes nothing about stopping a chase when there is no recipient", () => {
    // Pausing and cancelling stop things; whether anyone was going to be
    // emailed does not change what they do.
    for (const action of ["pause", "cancel"] as const) {
      expect(
        invoiceActionConsequence(action, { invoiceNumber: "INV-1001", hasRecipient: false }),
      ).toBe(invoiceActionConsequence(action, invoice));
    }
  });

  /**
   * ⚠️ FOUND ON SCREEN, ONE CLICK AFTER THE FEATURE WORKED.
   *
   * The confirm panel warned "nobody is set to receive reminders … nothing will
   * be sent". The activation succeeded. The success line then said "Eva will
   * chase it on your reminder schedule" — contradicting the warning it had just
   * given, on an invoice with zero queued reminders in the database.
   *
   * A product that overrules its own warning teaches people to ignore the next
   * one, which is the whole value of a warning.
   */
  it("does not promise a chase afterwards that it warned would not happen", () => {
    for (const action of ["activate", "resume"] as const) {
      const text = invoiceActionSuccess(action, "INV-1001", { hasRecipient: false });
      expect(text).toMatch(/nobody set to receive reminders/i);
      expect(text).toMatch(/nothing will be sent/i);
      expect(text).not.toMatch(/reminder schedule|fresh schedule from today/i);
    }
  });

  it("still says the cheerful thing when there IS somebody to email", () => {
    expect(invoiceActionSuccess("activate", "INV-1001", { hasRecipient: true })).toMatch(
      /reminder schedule/i,
    );
    expect(invoiceActionSuccess("resume", "INV-1001", { hasRecipient: true })).toMatch(
      /fresh schedule/i,
    );
  });
});

describe("the labels", () => {
  it("gives every action a button, a confirm and an outcome, all distinct", () => {
    const labels = ALL.map(invoiceActionLabel);
    const confirms = ALL.map(invoiceActionConfirmLabel);
    expect(new Set(labels).size).toBe(ALL.length);
    expect(new Set(confirms).size).toBe(ALL.length);
    // Never a bare "OK" or "Confirm" — the confirm button repeats the verb, so
    // a click at the wrong moment is a click on a sentence rather than a shape.
    for (const confirm of confirms) expect(confirm).toMatch(/^Yes, /);
  });

  it("marks only cancel as irreversible", () => {
    expect(isInvoiceActionIrreversible("cancel")).toBe(true);
    for (const action of ["activate", "pause", "resume"] as const) {
      expect(isInvoiceActionIrreversible(action)).toBe(false);
    }
  });

  it("never describes a cancelled invoice in words that could mean paid", () => {
    // Trap 7 again, this time in the outcome line.
    const text = invoiceActionSuccess("cancel", "INV-1001", { hasRecipient: true });
    expect(text).toMatch(/cancelled/i);
    expect(text).not.toMatch(/paid|settled|done|complete/i);
  });
});
