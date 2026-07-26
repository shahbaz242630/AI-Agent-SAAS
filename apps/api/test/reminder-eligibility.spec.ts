import { describe, expect, it } from "vitest";
import { checkReminderEligibility } from "../src/modules/reminders/reminder-eligibility.js";

/**
 * Slice 1.5 schedule-time eligibility (plan §3/§6): Active-only invoices,
 * a linked live contact with an email, and the suppression re-check (BRD
 * 4.1). Pure function — the caller loads the invoice/contact and evaluates
 * `isSuppressed` (which already case-folds; see suppression.spec.ts).
 */

const liveContact = { deletedAt: null, email: "finance@customer.example" };

describe("checkReminderEligibility (plan §3, BRD 4.1)", () => {
  it("active invoice + live contact with email + not suppressed → eligible", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: liveContact,
        suppressed: false,
      }),
    ).toEqual({ eligible: true });
  });

  it.each(["draft", "paused", "disputed", "paid", "cancelled"])(
    "stored status %s → not_active (never scheduled)",
    (invoiceStatus) => {
      expect(
        checkReminderEligibility({ invoiceStatus, contact: liveContact, suppressed: false }),
      ).toEqual({ eligible: false, reason: "not_active" });
    },
  );

  it("no linked contact → no_contact", () => {
    expect(
      checkReminderEligibility({ invoiceStatus: "active", contact: null, suppressed: false }),
    ).toEqual({ eligible: false, reason: "no_contact" });
  });

  it("soft-deleted contact (still linked on invoices.contact_id — the 1.4 observation) → contact_deleted", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { deletedAt: new Date("2026-03-01T00:00:00Z"), email: "finance@customer.example" },
        suppressed: false,
      }),
    ).toEqual({ eligible: false, reason: "contact_deleted" });
  });

  it.each([null, "", "   "])("contact email %j → no_email", (email) => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { deletedAt: null, email },
        suppressed: false,
      }),
    ).toEqual({ eligible: false, reason: "no_email" });
  });

  it("suppressed contact email → suppressed (BRD 4.1: permanent, cross-channel)", () => {
    expect(
      checkReminderEligibility({ invoiceStatus: "active", contact: liveContact, suppressed: true }),
    ).toEqual({ eligible: false, reason: "suppressed" });
  });

  it("reports the most useful reason when several exclusions apply", () => {
    // Check order: status → contact presence → deletion → email → suppression.
    expect(
      checkReminderEligibility({ invoiceStatus: "paused", contact: null, suppressed: true }),
    ).toEqual({ eligible: false, reason: "not_active" });
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { deletedAt: new Date("2026-03-01T00:00:00Z"), email: null },
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "contact_deleted" });
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { deletedAt: null, email: null },
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "no_email" });
  });
});
