import { describe, expect, it } from "vitest";
import {
  alsoAffectsLine,
  bookCountLine,
  contactLine,
  evidenceSummary,
  leadName,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
  type AlsoAffected,
} from "@/products/lead-follow-up/lead-book";
import { describeMoment } from "@/lib/today";

describe("lead vocabulary", () => {
  it("says the sources this product produces the way a person would", () => {
    expect(leadSourceLabel("email_enquiry")).toBe("Email enquiry");
    // Since 3.3b — and spelt the way the brand spells itself, which
    // `sentenceCase` cannot do.
    expect(leadSourceLabel("whatsapp_enquiry")).toBe("WhatsApp enquiry");
  });

  /**
   * ⚠️ THESE THREE ARE RETIRED, NOT GONE, AND ONE IS SITTING IN PRODUCTION.
   * They were removed from Lead Follow-up on 2026-08-21 — all three
   * are call-shaped and belong to Lead Follow-up by Call — but migration 0027
   * widened the CHECK rather than narrowing it, because lead `cc1c3243` is a
   * `callback_request` and evidence must never be rewritten. So the book still
   * has to render them, and rendering `callback_request` at a customer is the
   * same defect as "modules" leaking onto the sidebar.
   */
  it("still reads the retired call sources, because one is in the database", () => {
    expect(leadSourceLabel("callback_request")).toBe("Callback request");
    expect(leadSourceLabel("missed_call")).toBe("Missed call");
    expect(leadSourceLabel("existing_customer")).toBe("Existing customer");
  });

  /**
   * ⚠️ THE WINDOW THIS COVERS IS REAL AND ARRIVES AT 3.1b. The API starts
   * writing new sources the moment Eva can read a mailbox, and web deploys
   * trail api deploys by minutes. For that window this build has never heard of
   * the value — and a raw database word on a customer's screen is the same
   * defect as "modules" leaking onto the sidebar.
   */
  it("turns a source it has never heard of into English", () => {
    expect(leadSourceLabel("whatsapp_message")).toBe("Whatsapp message");
    expect(leadSourceLabel("")).toBe("Enquiry");
  });

  it("names the two states and how loud each is", () => {
    expect(leadStatusLabel("new")).toBe("New");
    expect(leadStatusLabel("do_not_contact")).toBe("Do not contact");
    expect(leadStatusTone("do_not_contact")).toBe("bad");
    expect(leadStatusTone("new")).toBe("mute");
  });
});

describe("how to reach them", () => {
  it("shows both ways when both are known", () => {
    expect(contactLine({ contactEmail: "sam@example.com", contactPhone: "07700 900123" })).toBe(
      "sam@example.com · 07700 900123",
    );
  });

  it("shows whichever one there is", () => {
    expect(contactLine({ contactEmail: null, contactPhone: "07700 900123" })).toBe("07700 900123");
    expect(contactLine({ contactEmail: "sam@example.com", contactPhone: null })).toBe(
      "sam@example.com",
    );
  });

  /**
   * The API and a CHECK constraint both refuse a lead with neither, so this is
   * the impossible case — and it still must not render an empty cell, which
   * reads as a broken screen rather than as missing data.
   */
  it("says so rather than printing nothing", () => {
    expect(contactLine({ contactEmail: null, contactPhone: null })).toBe("No contact details");
    expect(contactLine({ contactEmail: "  ", contactPhone: "" })).toBe("No contact details");
  });

  it("stands in for a missing name", () => {
    expect(leadName({ contactName: "Sam Okafor" })).toBe("Sam Okafor");
    expect(leadName({ contactName: "   " })).toBe("Someone who didn't leave a name");
    expect(leadName({ contactName: null })).toBe("Someone who didn't leave a name");
  });
});

describe("the count line", () => {
  it("counts in words a person would use", () => {
    expect(bookCountLine(0)).toBe("No enquiries yet.");
    expect(bookCountLine(1)).toBe("1 enquiry.");
    expect(bookCountLine(12)).toBe("12 enquiries.");
  });
});

describe("the evidence sentence", () => {
  it("answers why contacting them is lawful, not just what happened", () => {
    const line = evidenceSummary(
      { channel: "email_enquiry", occurredAt: "2026-08-19T13:30:00.000Z" },
      "Europe/London",
    );
    expect(line).toContain("They got in touch themselves");
    expect(line).toContain("email enquiry");
    expect(line).toContain("lawful");
  });

  /**
   * ⚠️ NO EVIDENCE MUST READ AS A STOP, NOT AS A BLANK. The lead and its
   * evidence are written in one transaction precisely so this cannot happen —
   * but if it ever does, the screen has to say Eva will not act, because the
   * BRD's rule is that an unevidenced lead never enters the queue.
   */
  it("says Eva will not act when there is no evidence", () => {
    const line = evidenceSummary(null, "Europe/London");
    expect(line).toContain("will not contact");
  });
});

describe("moments, in the organisation's timezone", () => {
  it("reads a British summer afternoon as the customer's clock, not the server's", () => {
    // 13:30 UTC in August is 14:30 in London (BST).
    expect(describeMoment("2026-08-19T13:30:00.000Z", "Europe/London")).toBe(
      "Wednesday 19 August at 2:30pm",
    );
  });

  it("moves the same instant for a customer in another zone", () => {
    expect(describeMoment("2026-08-19T13:30:00.000Z", "Asia/Dubai")).toBe(
      "Wednesday 19 August at 5:30pm",
    );
  });

  it("does not lose the screen to a bad timezone or a bad date", () => {
    expect(describeMoment("2026-08-19T13:30:00.000Z", "Mars/Olympus")).toContain("19 August");
    expect(describeMoment("not-a-date", "Europe/London")).toBe("at an unknown time");
  });
});

/**
 * ⚠️ THE WARNING THAT WAS MISSING WHEN THE FOUNDER WALKED IT (2026-08-20).
 * The first enquiry ever logged on production used an address that was already
 * a client's billing contact. Recording a do-not-contact would have stopped
 * invoice chasers to that client, and the screen said only "every channel,
 * permanently" — abstract enough that nobody reads it as a consequence.
 */
describe("what a do-not-contact will also stop", () => {
  const client = (customerName: string): AlsoAffected => ({
    customerId: customerName,
    customerName,
    matchedOn: ["email"],
  });

  it("says nothing when nobody else is affected", () => {
    expect(alsoAffectsLine([])).toBeNull();
  });

  /** ⚠️ THE NAME IS THE WHOLE VALUE. "1 other client affected" is the same
   *  disclaimer wearing a number — it reports that a consequence exists
   *  without saying what it is, which leaves the reader unable to decide. */
  it("names the client rather than counting them", () => {
    const line = alsoAffectsLine([client("Meridian Logistics Ltd")])!;
    expect(line).toContain("Meridian Logistics Ltd");
    expect(line).toContain("invoices");
    expect(line).not.toMatch(/1 (other )?client/);
  });

  it("writes two and three the way a person would", () => {
    expect(alsoAffectsLine([client("Acme"), client("Byrne")])!).toContain("Acme and Byrne");
    expect(alsoAffectsLine([client("Acme"), client("Byrne"), client("Crowe")])!).toContain(
      "Acme, Byrne and Crowe",
    );
  });

  /** A paragraph of names is not read either, so past three it trims — but it
   *  still NAMES three, so the reader knows the kind of thing at stake. */
  it("trims a long list without hiding that it is long", () => {
    const line = alsoAffectsLine(["Acme", "Byrne", "Crowe", "Dunn", "Ellis"].map(client))!;
    expect(line).toContain("Acme, Byrne and Crowe");
    expect(line).toContain("2 more");
  });

  it("agrees with itself about one client versus several", () => {
    expect(alsoAffectsLine([client("Acme")])!).toContain("is on your client list");
    expect(alsoAffectsLine([client("Acme"), client("Byrne")])!).toContain(
      "are on your client list",
    );
  });
});
