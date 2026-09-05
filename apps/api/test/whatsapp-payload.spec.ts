import { describe, expect, it } from "vitest";
import {
  forwardingOf,
  parseWhatsAppWebhook,
  textOf,
  toJsonValue,
} from "../src/capabilities/messaging/meta/whatsapp-payload.js";

/**
 * Reading Meta's webhook without trusting it (slice 3.2c).
 *
 * The shapes below are Meta's own documented examples for the `messages`
 * field, trimmed to the parts we read. Every case has a must-fail twin
 * somewhere in this file: a parser that returned one delivery for anything
 * would pass the happy path and nothing else.
 */

const WABA = "102290129340398";
const PHONE_NUMBER_ID = "106540352242922";

function envelope(value: Record<string, unknown>, entryId: string = WABA) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: entryId, changes: [{ field: "messages", value }] }],
  };
}

const metadata = { display_phone_number: "15550783881", phone_number_id: PHONE_NUMBER_ID };

const textMessage = {
  from: "16505551234",
  id: "wamid.HBgLMTY1MDUwNzY1MjAVAgASGBQzQTdBRjE5RjE4NjQ3RUQ3RTk4NwA=",
  timestamp: "1725370800",
  type: "text",
  text: { body: "Hi, my boiler has stopped working. Can someone come today?" },
};

describe("parseWhatsAppWebhook: a text message", () => {
  const parsed = parseWhatsAppWebhook(
    envelope({
      messaging_product: "whatsapp",
      metadata,
      contacts: [{ profile: { name: "Jane Smith" }, wa_id: "16505551234" }],
      messages: [textMessage],
    }),
  );

  it("yields one delivery with the fields the intake stores", () => {
    expect(parsed.object).toBe("whatsapp_business_account");
    expect(parsed.deliveries).toHaveLength(1);
    const delivery = parsed.deliveries[0]!;
    expect(delivery).toMatchObject({
      wabaId: WABA,
      phoneNumberId: PHONE_NUMBER_ID,
      displayPhoneNumber: "15550783881",
      providerMessageId: textMessage.id,
      fromIdentifier: "16505551234",
      fromDisplayName: "Jane Smith",
      messageType: "text",
      textBody: "Hi, my boiler has stopped working. Can someone come today?",
    });
  });

  it("reads their clock, not ours", () => {
    expect(parsed.deliveries[0]!.receivedAt?.toISOString()).toBe("2024-09-03T13:40:00.000Z");
  });

  it("keeps the message, the contact and the metadata verbatim in the payload", () => {
    const payload = parsed.deliveries[0]!.payload;
    expect(payload.message).toEqual(textMessage);
    expect(payload.contact).toEqual({ profile: { name: "Jane Smith" }, wa_id: "16505551234" });
    expect(payload.metadata).toEqual(metadata);
  });

  it("counts no receipts and nothing malformed", () => {
    expect(parsed.statusUpdates).toBe(0);
    expect(parsed.malformed).toBe(0);
  });
});

describe("parseWhatsAppWebhook: what it refuses to invent", () => {
  it("matches the contact by wa_id, and leaves the name null when nobody matches", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({
        metadata,
        contacts: [{ profile: { name: "Somebody Else" }, wa_id: "19998887777" }],
        messages: [textMessage],
      }),
    );
    expect(parsed.deliveries[0]!.fromDisplayName).toBeNull();
  });

  it("yields nothing for another Meta object, and says which", () => {
    const parsed = parseWhatsAppWebhook({ object: "page", entry: [] });
    expect(parsed.object).toBe("page");
    expect(parsed.deliveries).toEqual([]);
  });

  it("yields nothing for a body that is not an object", () => {
    for (const body of [null, undefined, "x", 42, []]) {
      const parsed = parseWhatsAppWebhook(body);
      expect(parsed.deliveries).toEqual([]);
      expect(parsed.object).toBeNull();
    }
  });

  it("counts receipts for messages we sent instead of storing them", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({
        metadata,
        statuses: [
          { id: "wamid.sent1", status: "delivered", timestamp: "1725370800", recipient_id: "1" },
          { id: "wamid.sent2", status: "read", timestamp: "1725370801", recipient_id: "1" },
        ],
      }),
    );
    expect(parsed.deliveries).toEqual([]);
    expect(parsed.statusUpdates).toBe(2);
    expect(parsed.failedStatuses).toEqual([]);
  });

  /**
   * A receipt that says our message did not arrive (3.4a): the id and the
   * code are read for the log; the free text is not.
   */
  it("reads a failed receipt's id and error code, and nothing a person wrote", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({
        metadata,
        statuses: [
          { id: "wamid.sent1", status: "sent", timestamp: "1725370800", recipient_id: "1" },
          {
            id: "wamid.sent2",
            status: "failed",
            timestamp: "1725370801",
            recipient_id: "1",
            errors: [
              {
                code: 131047,
                title: "Re-engagement message",
                message: "Message failed to send because more than 24 hours have passed",
                error_data: { details: "the person's number, quoted back" },
              },
            ],
          },
          // Failed with no error array at all — still reported, with nulls.
          { id: "wamid.sent3", status: "failed", timestamp: "1725370802", recipient_id: "1" },
          // No id: nothing to name, so nothing to report.
          { status: "failed", timestamp: "1725370803", recipient_id: "1" },
        ],
      }),
    );
    expect(parsed.statusUpdates).toBe(4);
    expect(parsed.failedStatuses).toEqual([
      { providerMessageId: "wamid.sent2", code: 131047, title: "Re-engagement message" },
      { providerMessageId: "wamid.sent3", code: null, title: null },
    ]);
    expect(JSON.stringify(parsed.failedStatuses)).not.toContain("quoted back");
  });

  it("counts a message with no id or no sender as malformed rather than guessing", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({
        metadata,
        messages: [
          { from: "16505551234", timestamp: "1725370800", type: "text", text: { body: "no id" } },
          { id: "wamid.no-sender", timestamp: "1725370800", type: "text", text: { body: "x" } },
          "not even an object",
          textMessage,
        ],
      }),
    );
    expect(parsed.malformed).toBe(3);
    expect(parsed.deliveries).toHaveLength(1);
  });

  it("counts messages with no number to route by as malformed", () => {
    const withoutMetadata = parseWhatsAppWebhook(envelope({ messages: [textMessage] }));
    expect(withoutMetadata.malformed).toBe(1);
    expect(withoutMetadata.deliveries).toEqual([]);

    const withoutEntryId = parseWhatsAppWebhook(
      envelope({ metadata, messages: [textMessage] }, ""),
    );
    expect(withoutEntryId.malformed).toBe(1);
  });

  it("does not coerce a numeric id into a string id", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({ metadata, messages: [{ ...textMessage, id: 12345 }] }),
    );
    expect(parsed.malformed).toBe(1);
  });

  it("gives a null clock for a missing or unusable timestamp, not a wrong one", () => {
    for (const timestamp of [undefined, "", "not-a-number", "0", -5]) {
      const parsed = parseWhatsAppWebhook(
        envelope({ metadata, messages: [{ ...textMessage, timestamp }] }),
      );
      expect(parsed.deliveries[0]!.receivedAt).toBeNull();
    }
  });

  it("handles two messages in one change and two changes in one entry", () => {
    const second = { ...textMessage, id: "wamid.second", text: { body: "Second message" } };
    const parsed = parseWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            { field: "messages", value: { metadata, messages: [textMessage, second] } },
            {
              field: "messages",
              value: { metadata, messages: [{ ...textMessage, id: "wamid.third" }] },
            },
            {
              field: "something_else",
              value: { metadata, messages: [{ ...textMessage, id: "wamid.x" }] },
            },
          ],
        },
      ],
    });
    expect(parsed.deliveries.map((d) => d.providerMessageId)).toEqual([
      textMessage.id,
      "wamid.second",
      "wamid.third",
    ]);
  });
});

describe("textOf: the words in a message, whatever its type", () => {
  it("reads a text body", () => {
    expect(textOf({ type: "text", text: { body: "hello" } })).toBe("hello");
  });

  it("reads a media caption", () => {
    expect(textOf({ type: "image", image: { id: "m1", caption: "the leak" } })).toBe("the leak");
    expect(textOf({ type: "document", document: { id: "d1", caption: "quote" } })).toBe("quote");
  });

  it("reads the label of a tapped button or list row", () => {
    expect(textOf({ type: "button", button: { payload: "p", text: "Yes please" } })).toBe(
      "Yes please",
    );
    expect(
      textOf({
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "b1", title: "Book it" } },
      }),
    ).toBe("Book it");
    expect(
      textOf({
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "l1", title: "Morning" } },
      }),
    ).toBe("Morning");
  });

  it("is null for a message with no words at all", () => {
    expect(textOf({ type: "image", image: { id: "m1" } })).toBeNull();
    expect(textOf({ type: "sticker", sticker: { id: "s1" } })).toBeNull();
    expect(textOf({ type: "location", location: { latitude: 1, longitude: 2 } })).toBeNull();
    expect(textOf({ type: "unsupported", errors: [{ code: 131051 }] })).toBeNull();
    expect(textOf({})).toBeNull();
  });

  it("keeps non-ASCII text exactly", () => {
    const body = "مرحبا، أحتاج سباكاً 🔧 Zoë";
    expect(textOf({ type: "text", text: { body } })).toBe(body);
  });
});

/** Meta's `context` flags, read off the stored message for the reply rules (3.4a). */
describe("forwardingOf: was this passed along?", () => {
  it("reads both flags, and a frequently forwarded message counts as forwarded too", () => {
    expect(forwardingOf({ ...textMessage })).toEqual({
      forwarded: false,
      frequentlyForwarded: false,
    });
    expect(forwardingOf({ ...textMessage, context: { forwarded: true } })).toEqual({
      forwarded: true,
      frequentlyForwarded: false,
    });
    expect(forwardingOf({ ...textMessage, context: { frequently_forwarded: true } })).toEqual({
      forwarded: true,
      frequentlyForwarded: true,
    });
  });

  /** A context that is a reply (`context.id`) or malformed says nothing about forwarding. */
  it("does not invent a flag from a context that carries none", () => {
    expect(
      forwardingOf({ ...textMessage, context: { from: "1", id: "wamid.replied-to" } }),
    ).toEqual({ forwarded: false, frequentlyForwarded: false });
    expect(forwardingOf({ ...textMessage, context: "yes" })).toEqual({
      forwarded: false,
      frequentlyForwarded: false,
    });
    expect(forwardingOf({ ...textMessage, context: { forwarded: "true" } })).toEqual({
      forwarded: false,
      frequentlyForwarded: false,
    });
  });
});

describe("toJsonValue: a copy that JSON can hold", () => {
  it("keeps strings, numbers, booleans, nulls, arrays and objects", () => {
    const value = { a: "x", b: 1, c: true, d: null, e: [1, "two", { f: false }] };
    expect(toJsonValue(value)).toEqual(value);
  });

  it("drops what JSON cannot carry rather than failing at the database", () => {
    expect(toJsonValue({ u: undefined, fn: () => 1, n: Number.NaN, inf: Infinity })).toEqual({
      fn: null,
      n: null,
      inf: null,
    });
    expect(toJsonValue(undefined)).toBeNull();
  });
});
