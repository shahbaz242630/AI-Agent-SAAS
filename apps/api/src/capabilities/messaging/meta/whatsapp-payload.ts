/**
 * Reading a WhatsApp webhook without trusting it (slice 3.2c).
 *
 * ⚠️ NO SCHEMA VALIDATION, AND THAT IS THE SAME CALL THE RESEND DOOR MADE. A
 * validation pipe answers 400 to a shape it does not recognise, and a non-200
 * tells Meta to retry — for up to seven days, to every app subscribed to the
 * account. So a payload field we have not seen before would be redelivered
 * hundreds of times and never stored. This module reads the fields it needs,
 * counts what it could not read, and lets the caller answer 200 either way.
 *
 * What Meta sends (their "messages" webhook field), in the parts we read:
 *
 *   { object: "whatsapp_business_account",
 *     entry: [{ id: <WABA id>,
 *       changes: [{ field: "messages",
 *         value: { metadata: { display_phone_number, phone_number_id },
 *                  contacts: [{ wa_id, profile: { name } }],
 *                  messages: [{ id, from, timestamp, type, <type>: {...} }],
 *                  statuses: [...] } }] }] }
 *
 * `statuses` are delivery receipts for messages WE sent (3.4a sends); they
 * arrive on the same field. They are counted, and a `failed` one is read for
 * its message id and error so the intake can log it — Meta reports the closed
 * 24-hour window, a payment problem on the account and a blocked number this
 * way, after the send was accepted. Nothing stores them yet: that needs a
 * place the capability may write, and comes with the engine (3.5).
 */

/** A JSON value we are willing to store. Built by `toJsonValue`, never cast. */
export type StoredJsonValue =
  string | number | boolean | null | StoredJsonValue[] | { [key: string]: StoredJsonValue };

/** One message, normalised to what the intake stores. */
export interface WhatsAppDelivery {
  /** The WhatsApp Business Account the number belongs to (`entry[].id`). */
  wabaId: string;
  /** The number the message arrived at (`metadata.phone_number_id`). */
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  /** Meta's message id (`wamid.…`) — the idempotency key. */
  providerMessageId: string;
  /** The sender's `wa_id`: E.164 digits without the plus. */
  fromIdentifier: string;
  /** Their profile name as WhatsApp reported it, if it did. */
  fromDisplayName: string | null;
  /** text | image | audio | video | document | sticker | location | … */
  messageType: string;
  /** The words, if any: `text.body`, a media caption, or a tapped label. */
  textBody: string | null;
  /** Their clock. Null when the payload carried no usable timestamp. */
  receivedAt: Date | null;
  /** The message verbatim, plus the sender's contact entry and the metadata. */
  payload: { [key: string]: StoredJsonValue };
}

/** A receipt saying a message WE sent did not get through (3.4a). */
export interface FailedStatus {
  /** The `wamid` of what we sent — the id `OutboundMessage.deliver` returned. */
  providerMessageId: string;
  /** Meta's error code (131047 = the 24-hour window had closed), if given. */
  code: number | null;
  /** Meta's short title for it, if given. Never the free-text message. */
  title: string | null;
}

export interface ParsedWhatsAppWebhook {
  /** The object Meta named. Only `whatsapp_business_account` is ours today. */
  object: string | null;
  deliveries: WhatsAppDelivery[];
  /** Delivery receipts seen and deliberately not stored. */
  statusUpdates: number;
  /** The receipts that report a failure, read for the log. */
  failedStatuses: FailedStatus[];
  /** Message entries missing an id, a sender, or their number — not storable. */
  malformed: number;
}

export const WHATSAPP_WEBHOOK_OBJECT = "whatsapp_business_account";

/**
 * Turn a webhook body into the deliveries it carries.
 *
 * Never throws. A body that is not ours, not an object, or not shaped as
 * expected yields an empty result with the counters explaining why.
 */
export function parseWhatsAppWebhook(payload: unknown): ParsedWhatsAppWebhook {
  const result: ParsedWhatsAppWebhook = {
    object: null,
    deliveries: [],
    statusUpdates: 0,
    failedStatuses: [],
    malformed: 0,
  };
  if (!isRecord(payload)) return result;
  result.object = text(payload.object);
  if (result.object !== WHATSAPP_WEBHOOK_OBJECT) return result;

  for (const entry of asArray(payload.entry)) {
    if (!isRecord(entry)) continue;
    const wabaId = text(entry.id);

    for (const change of asArray(entry.changes)) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : null;
      const phoneNumberId = metadata ? text(metadata.phone_number_id) : null;

      const statuses = asArray(value.statuses);
      result.statusUpdates += statuses.length;
      for (const status of statuses) {
        const failed = failedStatusOf(status);
        if (failed) result.failedStatuses.push(failed);
      }

      const messages = asArray(value.messages);
      if (messages.length === 0) continue;
      if (!wabaId || !phoneNumberId) {
        // A message we cannot route: no account or no number to route it by.
        result.malformed += messages.length;
        continue;
      }
      const contacts = asArray(value.contacts).filter(isRecord);

      for (const message of messages) {
        if (!isRecord(message)) {
          result.malformed += 1;
          continue;
        }
        const providerMessageId = text(message.id);
        const fromIdentifier = text(message.from);
        if (!providerMessageId || !fromIdentifier) {
          result.malformed += 1;
          continue;
        }
        const contact = contacts.find((c) => text(c.wa_id) === fromIdentifier) ?? null;
        const profile = contact && isRecord(contact.profile) ? contact.profile : null;

        result.deliveries.push({
          wabaId,
          phoneNumberId,
          displayPhoneNumber: metadata ? text(metadata.display_phone_number) : null,
          providerMessageId,
          fromIdentifier,
          fromDisplayName: profile ? text(profile.name) : null,
          messageType: text(message.type) ?? "unknown",
          textBody: textOf(message),
          receivedAt: momentOf(message.timestamp),
          payload: {
            message: toJsonValue(message),
            contact: toJsonValue(contact),
            metadata: toJsonValue(metadata),
          },
        });
      }
    }
  }
  return result;
}

/**
 * A `statuses` entry that says our message failed, or null for every other
 * receipt. Meta's shape: `{ id, status: "failed", recipient_id, errors: [{
 * code, title, message, error_data: { details } }] }`. The code and the
 * title are kept; `message` and `details` are free text and stay out.
 */
function failedStatusOf(status: unknown): FailedStatus | null {
  if (!isRecord(status) || status.status !== "failed") return null;
  const providerMessageId = text(status.id);
  if (!providerMessageId) return null;
  const first = asArray(status.errors).find(isRecord) ?? null;
  return {
    providerMessageId,
    code: first && typeof first.code === "number" ? first.code : null,
    title: first ? text(first.title) : null,
  };
}

/**
 * Was this message passed along? Meta's `context.forwarded` and
 * `context.frequently_forwarded`, read off the stored message object so the
 * decision rules (3.4a) see what the person's phone said about it.
 */
export function forwardingOf(message: Record<string, unknown>): {
  forwarded: boolean;
  frequentlyForwarded: boolean;
} {
  const context = isRecord(message.context) ? message.context : null;
  return {
    forwarded: context?.forwarded === true || context?.frequently_forwarded === true,
    frequentlyForwarded: context?.frequently_forwarded === true,
  };
}

/**
 * The words in a message, whatever type it is.
 *
 * `text.body` for a text; the caption on an image, video or document; the
 * label of a tapped button or list row. A bare image, a sticker, a location or
 * a shared contact has none, and null is the honest answer — 3.3 stores the
 * media reference from `payload` separately, because a photo of the leaking
 * roof may BE the enquiry.
 */
export function textOf(message: Record<string, unknown>): string | null {
  const type = text(message.type);
  const part = type ? message[type] : undefined;
  if (!isRecord(part)) return null;
  const direct = text(part.body) ?? text(part.caption) ?? text(part.text);
  if (direct) return direct;
  const reply = isRecord(part.button_reply)
    ? part.button_reply
    : isRecord(part.list_reply)
      ? part.list_reply
      : null;
  return reply ? text(reply.title) : null;
}

/**
 * Copy a value keeping only what JSON can hold.
 *
 * ⚠️ A COPY, NOT A CAST. What we store must be exactly what JSON can express,
 * because `payload` is a `jsonb` column and the evidence of what a stranger
 * sent — a cast would let an `undefined` or a function through the type and
 * fail, or silently vanish, at the database. Building the value proves it.
 */
export function toJsonValue(value: unknown): StoredJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const out: { [key: string]: StoredJsonValue } = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue;
      out[key] = toJsonValue(inner);
    }
    return out;
  }
  // bigint, symbol, function: nothing a webhook can carry, nothing we keep.
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty string, or null. Numbers are NOT coerced: an id is a string. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** WhatsApp sends unix seconds as a string. Anything else is "no clock". */
function momentOf(timestamp: unknown): Date | null {
  const seconds =
    typeof timestamp === "string"
      ? Number(timestamp)
      : typeof timestamp === "number"
        ? timestamp
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}
