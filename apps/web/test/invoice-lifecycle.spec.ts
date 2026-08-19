import { describe, expect, it } from "vitest";
import type { InvoiceLifecycleAction } from "../src/products/invoice-follow-up/invoice-lifecycle";
import {
  availableInvoiceActions,
  canRecordPayment,
  chaseBlockedLine,
  draftBlockedLine,
  paymentRecordedLine,
  invoiceActionConfirmLabel,
  invoiceActionConsequence,
  invoiceActionLabel,
  invoiceActionSuccess,
  isBeingChased,
  isInvoiceActionIrreversible,
  isInvoiceLifecycleAction,
  storedStatusOf,
} from "../src/products/invoice-follow-up/invoice-lifecycle";

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

const invoice = { invoiceNumber: "INV-1001", chaseBlockedReason: null };

/** Every reason the API can send, so no branch is left to a single example. */
const BLOCKERS = ["no_contact", "contact_deleted", "no_email", "suppressed", "no_mailbox"];

describe("availableInvoiceActions — a mirror of the API's state machine", () => {
  it("offers exactly what the state machine allows from each stored status", () => {
    expect(availableInvoiceActions("draft")).toEqual(["activate", "cancel"]);
    expect(availableInvoiceActions("active")).toEqual(["pause", "cancel"]);
    expect(availableInvoiceActions("paused")).toEqual(["resume", "cancel"]);
  });

  it("offers nothing from a resting status, including every outcome status", () => {
    // These have no API path at all until slice 1.8. A button for one would be
    // a promise the product cannot keep.
    for (const status of ["cancelled", "paid", "promise_to_pay", "disputed", "written_off"]) {
      expect(availableInvoiceActions(status)).toEqual([]);
    }
  });

  /**
   * ⚠️ FOUND ON SCREEN. This table mirrors the api's state machine, and it went
   * stale the moment payments changed that machine: a part-paid, forty-days-
   * overdue invoice offered "Record a payment" and nothing else — no way to
   * stop chasing it at all. `partially_paid` is a CHASED status, so it stops
   * like any other invoice being chased.
   */
  it("lets a PART-PAID invoice be paused and cancelled, because Eva is still chasing it", () => {
    expect(availableInvoiceActions("partially_paid")).toEqual(["pause", "cancel"]);
    // It can never be activated — it was issued long ago — nor resumed, because
    // it was never paused.
    expect(availableInvoiceActions("partially_paid")).not.toContain("activate");
    expect(availableInvoiceActions("partially_paid")).not.toContain("resume");
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
      expect(invoiceActionSuccess(action, "INV-1001", { chaseBlockedReason: null })).toContain(
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

  it("warns that starting a chase will send nothing, for EVERY reason", () => {
    /**
     * ⚠️ THE SILENT CASES — five of them, and the first version of this code
     * knew about one. The scheduler refuses an invoice with no contact, a
     * removed contact, a contact with no email address, one who unsubscribed,
     * or an organisation with no working mailbox. In every one the transition
     * succeeds, the badge says Active, and zero reminders are written. Proven
     * on 2026-08-04: INV-5002 activated with no contact and `scheduled_actions`
     * stayed empty.
     *
     * ⚠️ RESUME TOO, not just activate. Both call the scheduler and both are
     * equally silent — treating this as an activation-only problem was the
     * first version's mistake.
     */
    for (const action of ["activate", "resume"] as const) {
      for (const reason of BLOCKERS) {
        const text = invoiceActionConsequence(action, {
          invoiceNumber: "INV-1001",
          chaseBlockedReason: reason,
        });
        expect(text).toMatch(/will not actually be chased/i);
        expect(text).toMatch(/nothing will be sent/i);
        // And it must NOT be the cheerful version.
        expect(text).not.toMatch(/will start chasing|fresh schedule/i);
      }
    }
  });

  it("gives each reason its own words, so nobody is told the wrong thing to fix", () => {
    const said = BLOCKERS.map((reason) =>
      invoiceActionConsequence("activate", {
        invoiceNumber: "INV-1001",
        chaseBlockedReason: reason,
      }),
    );
    expect(new Set(said).size).toBe(BLOCKERS.length);
    expect(said[BLOCKERS.indexOf("no_email")]).toMatch(/no email address/i);
    expect(said[BLOCKERS.indexOf("suppressed")]).toMatch(/asked not to be emailed/i);
    expect(said[BLOCKERS.indexOf("no_mailbox")]).toMatch(/no working mailbox/i);
  });

  it("still says something true about a reason it has never heard of", () => {
    // The web app can be older than the API it is talking to. Claiming all is
    // well because we do not recognise the word is the failure that matters.
    const text = invoiceActionConsequence("activate", {
      invoiceNumber: "INV-1001",
      chaseBlockedReason: "some_new_blocker",
    });
    expect(text).toMatch(/will not actually be chased/i);
    expect(text).toMatch(/nothing will be sent/i);
  });

  it("changes nothing about stopping a chase when something is blocking it", () => {
    // Pausing and cancelling stop things; whether anyone was going to be
    // emailed does not change what they do.
    for (const action of ["pause", "cancel"] as const) {
      expect(
        invoiceActionConsequence(action, {
          invoiceNumber: "INV-1001",
          chaseBlockedReason: "no_email",
        }),
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
      for (const reason of BLOCKERS) {
        const text = invoiceActionSuccess(action, "INV-1001", { chaseBlockedReason: reason });
        expect(text).toMatch(/nothing will be sent/i);
        expect(text).not.toMatch(/reminder schedule|fresh schedule from today/i);
      }
    }
  });

  it("uses the SAME words before and after, so the two cannot disagree", () => {
    // The defect was a warning and an outcome describing the same situation
    // differently. One phrase table is what stops it coming back.
    for (const reason of BLOCKERS) {
      const before = invoiceActionConsequence("activate", {
        invoiceNumber: "INV-1001",
        chaseBlockedReason: reason,
      });
      const after = invoiceActionSuccess("activate", "INV-1001", { chaseBlockedReason: reason });
      const phrase = chaseBlockedLine("active", reason)!
        .replace(/^Eva can't chase this — /, "")
        .slice(0, -1);
      expect(before).toContain(phrase);
      expect(after).toContain(phrase);
    }
  });

  it("still says the cheerful thing when nothing is in the way", () => {
    expect(invoiceActionSuccess("activate", "INV-1001", { chaseBlockedReason: null })).toMatch(
      /reminder schedule/i,
    );
    expect(invoiceActionSuccess("resume", "INV-1001", { chaseBlockedReason: null })).toMatch(
      /fresh schedule/i,
    );
  });
});

describe("recording a payment (tasks 5-7)", () => {
  it("is offered on an issued invoice that is not settled or abandoned", () => {
    for (const status of ["active", "paused", "partially_paid"]) {
      expect(canRecordPayment(status)).toBe(true);
    }
    // Including through the derived statuses — an overdue invoice is the one
    // most likely to be paid today.
    for (const derived of ["due_soon", "due_today", "overdue"]) {
      expect(canRecordPayment(derived)).toBe(true);
    }
  });

  it("is NOT offered on a draft, a settled or an abandoned invoice", () => {
    // A draft was never sent, so nothing can have been paid against it; a
    // cancelled invoice cannot be revived by a payment; a paid one is done.
    for (const status of ["draft", "cancelled", "paid", "written_off"]) {
      expect(canRecordPayment(status)).toBe(false);
    }
  });

  /**
   * ⚠️ EVERY BRANCH SAYS WHAT HAPPENS TO THE REST OF THE MONEY. That is the
   * entire point of being able to record a part payment: before it, a debtor
   * who owed 10,000 and paid 6,000 left two bad choices — chase the full
   * 10,000, or stop chasing the 4,000 still owed. "Payment recorded" on its own
   * would leave somebody guessing which they had just done.
   */
  it("says the balance is still being chased after a part payment", () => {
    const line = paymentRecordedLine({
      invoiceNumber: "INV-3001",
      status: "partially_paid",
      outstandingMinorUnits: 400_000,
      formattedOutstanding: "£4,000.00",
      chaseBlockedReason: null,
    });
    expect(line).toContain("£4,000.00");
    expect(line).toContain("INV-3001");
    expect(line).toMatch(/keeps chasing/i);
  });

  it("says a settled invoice is settled and the chase has stopped", () => {
    const line = paymentRecordedLine({
      invoiceNumber: "INV-3001",
      status: "paid",
      outstandingMinorUnits: 0,
      formattedOutstanding: "£0.00",
      chaseBlockedReason: null,
    });
    expect(line).toMatch(/settled in full/i);
    expect(line).toMatch(/stopped chasing/i);
    // And must not promise more chasing.
    expect(line).not.toMatch(/keeps chasing/i);
  });

  it("treats an overpayment as settled rather than reporting a negative balance", () => {
    // Overpayment is allowed (founder ruling) and the balance clamps at zero,
    // so this branch is reached with 0 rather than a minus figure.
    const line = paymentRecordedLine({
      invoiceNumber: "INV-3001",
      status: "paid",
      outstandingMinorUnits: 0,
      formattedOutstanding: "£0.00",
      chaseBlockedReason: null,
    });
    expect(line).toMatch(/settled in full/i);
    // No negative money anywhere — a minus balance would read as a debt owed
    // the other way. (Not a bare "-": the invoice number contains one.)
    expect(line).not.toMatch(/-\s*[£$€¥]|[£$€¥]\s*-/);
    expect(line).not.toMatch(/still owed/i);
  });

  it("says a paused invoice is STILL paused, so nobody expects chasing to resume", () => {
    // A part payment against a paused invoice deliberately leaves it paused —
    // somebody stopped that chase on purpose. Saying so is the difference
    // between a quiet surprise and a decision.
    const line = paymentRecordedLine({
      invoiceNumber: "INV-2005",
      status: "paused",
      outstandingMinorUnits: 89_000,
      formattedOutstanding: "£890.00",
      chaseBlockedReason: null,
    });
    expect(line).toMatch(/still paused/i);
    expect(line).toMatch(/not chasing/i);
    expect(line).toContain("£890.00");
  });

  it("does not promise to chase a balance nothing can be sent for", () => {
    // The same honesty rule as the lifecycle buttons: a balance is owed, and
    // Eva still cannot email anybody about it.
    for (const reason of BLOCKERS) {
      const line = paymentRecordedLine({
        invoiceNumber: "INV-3001",
        status: "partially_paid",
        outstandingMinorUnits: 400_000,
        formattedOutstanding: "£4,000.00",
        chaseBlockedReason: reason,
      });
      expect(line).toMatch(/nothing will be sent/i);
      expect(line).not.toMatch(/keeps chasing/i);
    }
  });
});

describe("what a DRAFT row says about the recipient it will need", () => {
  /**
   * ⚠️ THE GAP THIS CLOSES. The add form saves drafts BY DEFAULT, and a draft
   * said nothing at all about a missing address — so twenty invoices could be
   * typed with no recipient and the first warning would arrive one row at a
   * time, at the moment each was activated. Founder, 2026-08-18.
   */
  it("warns a draft about the recipient blockers a person can fix", () => {
    for (const reason of ["no_contact", "contact_deleted", "no_email", "suppressed"]) {
      const line = draftBlockedLine("draft", reason);
      expect(line).toMatch(/^Nothing will be sent when you start — /);
      expect(line).toMatch(/\.$/);
    }
  });

  /**
   * ⚠️ ITS TENSE IS THE WHOLE MESSAGE, and it must never borrow the other
   * line's. "Eva can't chase this" is FALSE of a draft — nobody asked her to —
   * and reads as a fault where there is none. This one is about what will
   * happen when you start.
   */
  it("does not claim Eva is failing at something she was never asked to do", () => {
    expect(draftBlockedLine("draft", "no_email")).not.toMatch(/can't chase/i);
  });

  /**
   * ⚠️ `no_mailbox` IS AN ORGANISATION-LEVEL FAULT and is true of every row at
   * once. Repeating it down a column of drafts would be a wall of identical
   * warnings about one thing that cannot be fixed from any of them.
   */
  it("stays quiet about a missing mailbox, which is not this row's problem", () => {
    expect(draftBlockedLine("draft", "no_mailbox")).toBeNull();
  });

  it("says nothing on anything that is not a draft", () => {
    for (const status of ["active", "paused", "overdue", "partially_paid", "paid", "cancelled"]) {
      expect(draftBlockedLine(status, "no_email")).toBeNull();
    }
  });

  it("stays silent on a draft with a perfectly good recipient", () => {
    expect(draftBlockedLine("draft", null)).toBeNull();
  });

  /**
   * The two lines must never both appear on one row: red says Eva is failing
   * now, amber says she would fail if you started. A row claiming both would be
   * telling the reader two different things about the same invoice.
   */
  it("never speaks at the same time as the chasing warning", () => {
    for (const status of ["draft", "active", "partially_paid", "paid"]) {
      for (const reason of ["no_contact", "contact_deleted", "no_email", "suppressed"]) {
        const both = [chaseBlockedLine(status, reason), draftBlockedLine(status, reason)].filter(
          (line) => line !== null,
        );
        expect(both.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("what the row says about whether Eva is chasing it", () => {
  it("stays silent when nothing is wrong", () => {
    expect(chaseBlockedLine("active", null)).toBeNull();
  });

  it("names every blocker in words a person can act on", () => {
    for (const reason of BLOCKERS) {
      const line = chaseBlockedLine("active", reason);
      expect(line).toMatch(/^Eva can't chase this — /);
      expect(line).toMatch(/\.$/);
    }
    expect(new Set(BLOCKERS.map((reason) => chaseBlockedLine("active", reason))).size).toBe(
      BLOCKERS.length,
    );
  });

  /**
   * ⚠️ FOUND ON SCREEN, and only there. `chaseBlockedReason` sets the status
   * aside, so an organisation with no mailbox reports `no_mailbox` on every
   * invoice it has — and the row for a SETTLED invoice read "Paid · Eva can't
   * chase this — no working mailbox is connected." Nobody wants to chase a paid
   * invoice. Worse, a doc comment in the module already claimed this behaviour
   * while the code did not have it.
   */
  it("says nothing on an invoice Eva was never going to chase", () => {
    for (const resting of ["draft", "paused", "cancelled", "paid", "written_off"]) {
      for (const reason of BLOCKERS) {
        expect(chaseBlockedLine(resting, reason)).toBeNull();
      }
    }
    // But an OVERDUE invoice is active, and is exactly where it must speak up.
    for (const derived of ["active", "due_soon", "due_today", "overdue"]) {
      expect(chaseBlockedLine(derived, "no_mailbox")).toMatch(/no working mailbox/);
    }
  });

  it("speaks up on a PART-PAID invoice, where money is still owed", () => {
    // It stayed silent on `partially_paid` at first, which is the worst place
    // to be quiet: a balance is outstanding and nothing is collecting it.
    expect(chaseBlockedLine("partially_paid", "no_mailbox")).toMatch(/no working mailbox/);
    expect(isBeingChased("partially_paid", null)).toBe(true);
    expect(isBeingChased("partially_paid", "no_email")).toBe(false);
  });

  /**
   * ⚠️ BOTH HALVES, AND THIS IS THE ONE THAT FIXES THE CANCELLED-BALANCE
   * DEFECT. The demo book's cancelled INV-1003 was showing £320.00 in the
   * Outstanding column in the same weight as live debt, because the balance is
   * amount minus paid and nothing asked whether anybody was collecting it.
   */
  it("counts an invoice as chased only when it is active AND unblocked", () => {
    expect(isBeingChased("active", null)).toBe(true);
    // The three derived statuses ARE active — an overdue invoice is the most
    // chased thing there is.
    for (const derived of ["due_soon", "due_today", "overdue"]) {
      expect(isBeingChased(derived, null)).toBe(true);
    }
    // Part paid IS chased — the balance is still owed and Eva still emails.
    expect(isBeingChased("partially_paid", null)).toBe(true);
    // Not chased: nobody is collecting it, whatever the balance says.
    for (const resting of ["draft", "paused", "cancelled", "paid", "written_off"]) {
      expect(isBeingChased(resting, null)).toBe(false);
    }
    // Active, but nothing can be sent.
    for (const reason of BLOCKERS) {
      expect(isBeingChased("active", reason)).toBe(false);
      expect(isBeingChased("overdue", reason)).toBe(false);
    }
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
    const text = invoiceActionSuccess("cancel", "INV-1001", { chaseBlockedReason: null });
    expect(text).toMatch(/cancelled/i);
    expect(text).not.toMatch(/paid|settled|done|complete/i);
  });
});
