import { describe, expect, it } from "vitest";
import { checkReminderEligibility } from "../src/products/invoice-follow-up/reminders/reminder-eligibility.js";

/**
 * Slice 1.5 schedule-time eligibility (plan §3/§6): Active-only invoices,
 * SOMEBODY with an email address, and the suppression re-check (BRD 4.1). Pure
 * function — the caller loads the invoice/contact/customer and evaluates
 * `isSuppressed` (which already case-folds; see suppression.spec.ts).
 *
 * ⚠️ EVERY "NO CONTACT" CASE HERE NOW ALSO SAYS THE CLIENT HAS NO ADDRESS, and
 * that is not padding. Since 2026-08-27 Eva falls back to the client's own
 * email, so `contact: null` on its own no longer decides anything. A version of
 * this file that kept passing bare `contact: null` would still be green and
 * would be testing a rule the product no longer has.
 */

const liveContact = {
  id: "c0000000-0000-4000-8000-000000000001",
  name: "Sam Okafor",
  deletedAt: null,
  email: "finance@customer.example",
};

/** A client with nothing to write to — the old tests' implicit assumption. */
const addresslessClient = { id: "d0000000-0000-4000-8000-000000000001", email: null };

/** A client that CAN be written to, which is what the fallback exists for. */
const reachableClient = {
  id: "d0000000-0000-4000-8000-000000000002",
  email: "hello@soletrader.example",
};

describe("checkReminderEligibility (plan §3, BRD 4.1)", () => {
  it("active invoice + live contact with email + not suppressed → eligible", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: liveContact,
        customer: addresslessClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: true });
  });

  it.each(["draft", "paused", "disputed", "paid", "cancelled"])(
    "stored status %s → not_active (never scheduled)",
    (invoiceStatus) => {
      expect(
        checkReminderEligibility({
          invoiceStatus,
          contact: liveContact,
          customer: addresslessClient,
          suppressed: false,
        }),
      ).toEqual({ eligible: false, reason: "not_active" });
    },
  );

  it("no contact and no client address → no_contact", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: null,
        customer: addresslessClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: false, reason: "no_contact" });
  });

  it("soft-deleted contact (still linked on invoices.contact_id — the 1.4 observation) → contact_deleted", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { ...liveContact, deletedAt: new Date("2026-03-01T00:00:00Z") },
        customer: addresslessClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: false, reason: "contact_deleted" });
  });

  it.each([null, "", "   "])("contact email %j and no client address → no_email", (email) => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { ...liveContact, email },
        customer: addresslessClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: false, reason: "no_email" });
  });

  it("suppressed → suppressed (BRD 4.1: permanent, cross-channel)", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: liveContact,
        customer: addresslessClient,
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "suppressed" });
  });

  it("reports the most useful reason when several exclusions apply", () => {
    // Check order: status → recipient → suppression; and within "no recipient",
    // the contact-side fact, because that is what a human can act on.
    expect(
      checkReminderEligibility({
        invoiceStatus: "paused",
        contact: null,
        customer: addresslessClient,
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "not_active" });
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { ...liveContact, deletedAt: new Date("2026-03-01T00:00:00Z"), email: null },
        customer: addresslessClient,
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "contact_deleted" });
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { ...liveContact, email: null },
        customer: addresslessClient,
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "no_email" });
  });
});

/**
 * 🚨 THE FOUNDER'S RULING, 2026-08-27, AS A TEST.
 *
 * Shown that the upload screen advertised both a client email and a contact
 * email: *"why do we have contact email and client email twice? …no need to
 * duplicate"*. It was worse than duplication — the client's address was read by
 * nothing, so the most natural column for a small business to fill in was the
 * one that did nothing, and an ordinary spreadsheet imported clean and produced
 * invoices Eva would never send.
 *
 * These are the cases that were BLOCKED before that ruling and are chased now.
 */
describe("the client's own address is a real recipient (founder, 2026-08-27)", () => {
  it("chases a sole trader who has no named contact at all", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: null,
        customer: reachableClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: true });
  });

  it("chases when the contact has no email of their own", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { ...liveContact, email: null },
        customer: reachableClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: true });
  });

  /**
   * ⚠️ REMOVING A PERSON IS NOT FORGIVING A DEBT. The client's address is still
   * good, and suppression — not deletion — is how a chase is stopped.
   */
  it("chases when the contact was deleted but the client is still reachable", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: { ...liveContact, deletedAt: new Date("2026-03-01T00:00:00Z") },
        customer: reachableClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: true });
  });

  /**
   * ⚠️ THE CASE THAT MUST STILL FAIL. The fallback widens who can be chased; it
   * must not widen it past somebody who asked never to be emailed. The caller
   * computes this verdict against the address `resolveRecipient` picked — see
   * `reminder-actions.ts`, where checking the contact's address instead would
   * have answered "not suppressed" about an address nobody was writing to.
   */
  it("still refuses when the address it would use is suppressed", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "active",
        contact: null,
        customer: reachableClient,
        suppressed: true,
      }),
    ).toEqual({ eligible: false, reason: "suppressed" });
  });

  it("still refuses a draft, however reachable the client is", () => {
    expect(
      checkReminderEligibility({
        invoiceStatus: "draft",
        contact: null,
        customer: reachableClient,
        suppressed: false,
      }),
    ).toEqual({ eligible: false, reason: "not_active" });
  });
});
