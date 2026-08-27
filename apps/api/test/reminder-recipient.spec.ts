import { describe, expect, it } from "vitest";
import { resolveRecipient } from "../src/products/invoice-follow-up/reminders/reminder-recipient.js";

/**
 * WHO EVA WRITES TO — the single answer four readers now share (founder ruling,
 * 2026-08-27). See `reminder-recipient.ts` for why it exists at all.
 */

const contact = {
  id: "c0000000-0000-4000-8000-000000000001",
  name: "Sam Okafor",
  deletedAt: null,
  email: "sam@bigclient.example",
};
const customer = { id: "d0000000-0000-4000-8000-000000000001", email: "hello@soletrader.example" };

describe("resolveRecipient", () => {
  it("prefers a named contact — that is the point of naming one", () => {
    expect(resolveRecipient({ contact, customer })).toEqual({
      email: "sam@bigclient.example",
      name: "Sam Okafor",
      via: "contact",
      spacingKey: `contact:${contact.id}`,
    });
  });

  it("falls back to the client when there is no contact", () => {
    expect(resolveRecipient({ contact: null, customer })).toEqual({
      email: "hello@soletrader.example",
      name: null,
      via: "customer",
      spacingKey: `customer:${customer.id}`,
    });
  });

  it.each([
    ["the contact has no email", { ...contact, email: null }],
    ["the contact's email was cleared to empty", { ...contact, email: "" }],
    ["the contact's email is only whitespace", { ...contact, email: "   " }],
    ["the contact was deleted", { ...contact, deletedAt: new Date("2026-03-01T00:00:00Z") }],
  ])("falls back to the client when %s", (_why, brokenContact) => {
    const resolved = resolveRecipient({ contact: brokenContact, customer });
    expect(resolved?.email).toBe("hello@soletrader.example");
    expect(resolved?.via).toBe("customer");
  });

  it("answers nobody when neither has an address", () => {
    expect(
      resolveRecipient({ contact: null, customer: { id: customer.id, email: null } }),
    ).toBeNull();
    expect(resolveRecipient({ contact: null, customer: null })).toBeNull();
    expect(
      resolveRecipient({
        contact: { ...contact, email: "" },
        customer: { id: customer.id, email: "  " },
      }),
    ).toBeNull();
  });

  it("trims the address it hands over, because a stored space is not an address", () => {
    expect(
      resolveRecipient({ contact: { ...contact, email: " sam@x.example " }, customer })?.email,
    ).toBe("sam@x.example");
  });

  /**
   * 🚨 THE GREETING, AND WHY THE FALLBACK HAS NO NAME.
   *
   * `reminder-message.ts` turns a name into "Hi Sarah," and null into "Hello,".
   * A client's name is a BUSINESS name as often as a person's, and nothing here
   * can tell "Dan Kerrison" from "Kerrison Joinery Ltd". Handing the client name
   * through would have opened debt-chasing letters with "Hi Kerrison Joinery
   * Ltd," — sent from our customer's own mailbox, over their name.
   *
   * If this is ever reversed, it must be reversed knowingly: delete this test
   * rather than let it rot.
   */
  it("greets nobody by name on the client fallback", () => {
    expect(resolveRecipient({ contact: null, customer })?.name).toBeNull();
  });

  /**
   * 🚨 THE 3-DAY SPACING LOCK KEYS ON THIS, AND IT USED TO BE `contact.id`.
   *
   * `reminder-actions.ts` takes `pg_advisory_xact_lock(hashtext(...))` so two
   * invoices for one person cannot be scheduled a day apart (BRD 4.1). There is
   * no contact id on the fallback path, so a key that did not distinguish the
   * two levels would have locked on the same value — or on nothing — for every
   * client the fallback made chaseable, and somebody with four overdue invoices
   * could have been sent four emails in one morning.
   */
  describe("the spacing key", () => {
    it("is distinct per level, so a contact and a client never share a lock", () => {
      const viaContact = resolveRecipient({ contact, customer })!;
      const viaCustomer = resolveRecipient({ contact: null, customer })!;
      expect(viaContact.spacingKey).not.toBe(viaCustomer.spacingKey);
    });

    it("is stable for the same recipient across different invoices", () => {
      const first = resolveRecipient({ contact: null, customer })!;
      const second = resolveRecipient({ contact: null, customer: { ...customer } })!;
      expect(first.spacingKey).toBe(second.spacingKey);
    });

    /**
     * ⚠️ NOT THE BARE ID. A contact id and a customer id are both uuids from
     * the same generator; without the prefix two different people could collide
     * on one lock the day those uuids happened to match, and the failure would
     * be a reminder mysteriously deferred with nothing to explain it.
     */
    it("names which level it came from", () => {
      expect(resolveRecipient({ contact, customer })!.spacingKey).toMatch(/^contact:/);
      expect(resolveRecipient({ contact: null, customer })!.spacingKey).toMatch(/^customer:/);
    });
  });
});
