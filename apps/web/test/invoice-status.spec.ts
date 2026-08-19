import { INVOICE_COMPUTED_STATUSES, INVOICE_STORED_STATUSES } from "@eva/types";
import { describe, expect, it } from "vitest";
import {
  invoiceEditBlockedReason,
  invoiceStatusLabel,
  invoiceStatusTone,
  isInvoiceEditable,
} from "../src/products/invoice-follow-up/invoice-status";

/**
 * Slice 1.6c plan §6: "every one of the nine stored plus three computed
 * statuses". Driven off the exported constants rather than a hand-written list,
 * so a status added to `@eva/types` fails this suite instead of quietly going
 * unlabelled.
 */
const ALL_STATUSES = [...INVOICE_STORED_STATUSES, ...INVOICE_COMPUTED_STATUSES];

describe("invoiceStatusLabel", () => {
  it("covers all twelve statuses with something a human would write", () => {
    expect(ALL_STATUSES).toHaveLength(12);
    for (const status of ALL_STATUSES) {
      const label = invoiceStatusLabel(status);
      expect(label, status).not.toBe("");
      // A label that is still snake_case is a mapping that was never written.
      expect(label, status).not.toMatch(/_/);
      expect(label[0], status).toBe(label[0]?.toUpperCase());
    }
  });

  it("writes the three the plan names, exactly as the plan names them", () => {
    expect(invoiceStatusLabel("overdue")).toBe("Overdue");
    expect(invoiceStatusLabel("due_today")).toBe("Due today");
    expect(invoiceStatusLabel("partially_paid")).toBe("Part paid");
  });

  it("NEVER lets a cancelled invoice read as a paid one", () => {
    // Trap 7, and it is not hypothetical: until this slice, cancelling was the
    // only way to stop chasing someone, so the trail already says `cancelled`
    // in places where the debtor actually paid. A label that blurs the two
    // makes that history unreadable.
    const cancelled = invoiceStatusLabel("cancelled").toLowerCase();
    expect(cancelled).toBe("cancelled");
    expect(cancelled).not.toMatch(/paid|settled|complete|closed|done/);
    expect(invoiceStatusTone("cancelled")).not.toBe("positive");
    // Only genuine payment is good news.
    expect(invoiceStatusTone("paid")).toBe("positive");
  });

  it("keeps every label distinct, so two statuses never look like one", () => {
    const labels = ALL_STATUSES.map((status) => invoiceStatusLabel(status));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("says something readable about a status it has never heard of", () => {
    // The web app can be older than the API it is talking to — during a deploy
    // it demonstrably is. An unrecognised status must not crash the page, and
    // must not be quietly mapped onto one we do recognise.
    expect(invoiceStatusLabel("some_new_state")).toBe("Some new state");
    expect(invoiceStatusLabel("")).toBe("Unknown");
    expect(invoiceStatusTone("some_new_state")).toBe("neutral");
  });

  it("does not dress an unknown status as good news or as an alarm", () => {
    expect(invoiceStatusTone("wildly_unexpected")).not.toBe("positive");
    expect(invoiceStatusTone("wildly_unexpected")).not.toBe("urgent");
  });
});

describe("invoiceStatusTone", () => {
  it("gives every status a tone", () => {
    for (const status of ALL_STATUSES) {
      expect(invoiceStatusTone(status), status).toBeTruthy();
    }
  });

  it("treats an overdue invoice as urgent and a draft as quiet", () => {
    expect(invoiceStatusTone("overdue")).toBe("urgent");
    expect(invoiceStatusTone("draft")).toBe("muted");
  });

  it("does not treat a part-paid invoice as finished — there is still a balance", () => {
    expect(invoiceStatusTone("partially_paid")).not.toBe("positive");
    expect(invoiceStatusTone("partially_paid")).not.toBe("muted");
  });
});

describe("editability — PATCH is draft-only (trap 4)", () => {
  it("allows editing a draft and nothing else", () => {
    expect(isInvoiceEditable("draft")).toBe(true);
    for (const status of ALL_STATUSES.filter((s) => s !== "draft")) {
      expect(isInvoiceEditable(status), status).toBe(false);
    }
  });

  it("gives no reason when editing IS allowed", () => {
    expect(invoiceEditBlockedReason("draft")).toBeNull();
  });

  it("explains itself for every status it blocks, rather than just hiding the button", () => {
    // A control that vanishes with no explanation reads as a missing feature,
    // and the customer goes looking for it. The API would answer a PATCH here
    // with a 400 they can do nothing about.
    for (const status of ALL_STATUSES.filter((s) => s !== "draft")) {
      const reason = invoiceEditBlockedReason(status);
      expect(reason, status).toBeTruthy();
      expect(reason, status).toMatch(/\.$/);
    }
  });

  it("does not tell someone a cancelled invoice was 'issued'", () => {
    // The generic sentence is true of an active invoice and false of a
    // cancelled one. Copy that is true in the common case and false in the
    // others is exactly what 97eae17 was about.
    expect(invoiceEditBlockedReason("cancelled")).toMatch(/cancelled/i);
    expect(invoiceEditBlockedReason("cancelled")).not.toMatch(/issued/i);
    expect(invoiceEditBlockedReason("paid")).toMatch(/paid/i);
    expect(invoiceEditBlockedReason("paid")).not.toMatch(/issued/i);
    expect(invoiceEditBlockedReason("active")).toMatch(/issued/i);
  });
});
