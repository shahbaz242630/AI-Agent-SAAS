/**
 * Fetching the message a webhook only told us about (Slice 3.1b).
 *
 * ⚠️ THE WEBHOOK DOES NOT CONTAIN THE EMAIL. Resend's `email.received` payload
 * carries metadata only — sender, recipient, subject, ids, attachment
 * descriptions — and explicitly not the body, the headers or the attachments.
 * Those come from a second, authenticated call.
 *
 * That single fact shapes the whole intake path:
 *  - it is a NETWORK CALL that can fail on its own, after we have already told
 *    Resend "received", so the delivery must be written down BEFORE it runs;
 *  - the HEADERS ruling 32's loop-stopper depends on (`Auto-Submitted`,
 *    `Precedence`, `List-*`) are only here, not in the webhook — so a design
 *    that skipped this call could never tell an enquiry from an auto-reply.
 */

/** What `email.received` actually delivers. Metadata, and nothing more. */
export interface InboundWebhookPayload {
  type: string;
  data: {
    email_id: string;
    created_at?: string;
    from?: string;
    to?: string[];
    /** The address(es) of ours it was delivered to. The routing key. */
    received_for?: string[];
    message_id?: string;
    subject?: string;
  };
}

/** The message itself, once fetched. */
export interface ReceivedMessage {
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  /** Lowercased keys — header names are case-insensitive and senders vary. */
  headers: Record<string, string>;
}

/**
 * The seam. An interface rather than a direct `fetch`, so the intake path can
 * be tested without the network and so ruling 34's move off Resend (Cloudflare
 * Email Routing is the named alternative) is one class rather than a rewrite.
 */
export const RECEIVED_MAIL = Symbol("RECEIVED_MAIL");

export interface ReceivedMail {
  fetch(providerMessageId: string): Promise<ReceivedMessage>;
}

/**
 * Header names arrive in whatever case the sending client chose — `Message-ID`,
 * `MESSAGE-ID` and `message-id` are the same header per RFC 5322 §2.2. Lowered
 * on the way in so the rules that read them (3.1b, ruling 32) can ask once.
 */
export function normaliseHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    // Some parsers hand back repeated headers as an array (`Received` is the
    // usual one). Joined rather than dropped: a header that appears twice still
    // has to be readable, and losing it silently is how a loop-stopper stops
    // stopping loops.
    else if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.filter((item) => typeof item === "string").join(", ");
    }
  }
  return out;
}

/** Resend's Received Emails API: `GET /emails/receiving/{id}`. */
export class ResendReceivedMail implements ReceivedMail {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.resend.com",
  ) {}

  async fetch(providerMessageId: string): Promise<ReceivedMessage> {
    const response = await globalThis.fetch(
      `${this.baseUrl}/emails/receiving/${encodeURIComponent(providerMessageId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      },
    );

    if (!response.ok) {
      /**
       * ⚠️ THE STATUS, NOT THE BODY. An error body from a mail provider can
       * quote the message it was about — sender, subject, sometimes content —
       * and this string ends up in `inbound_messages.failure_reason` and in the
       * log. The status code says what to do about it; the body would leak a
       * stranger's enquiry into somewhere far more widely read than the lead.
       */
      throw new Error(`Resend refused to return the message (HTTP ${response.status})`);
    }

    const body = (await response.json()) as {
      from?: unknown;
      subject?: unknown;
      text?: unknown;
      html?: unknown;
      headers?: unknown;
    };

    return {
      from: typeof body.from === "string" ? body.from : "",
      subject: typeof body.subject === "string" ? body.subject : null,
      text: typeof body.text === "string" ? body.text : null,
      html: typeof body.html === "string" ? body.html : null,
      headers: normaliseHeaders(body.headers),
    };
  }
}
