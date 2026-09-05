import { Inject, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
import {
  ChannelUnusableError,
  MessageDeliveryDeferredError,
  MessageDeliveryError,
  type OutboundMessage,
  type OutboundMessageDelivery,
  type OutboundMessageReceipt,
} from "../outbound-message.js";

/**
 * Sending on WhatsApp through Meta's Cloud API (slice 3.4a) — the ONLY place
 * `graph.facebook.com` is written to.
 *
 * The request is the one Meta documents for a contextual text reply:
 *
 *   POST /{version}/{phone_number_id}/messages
 *   { messaging_product: "whatsapp", recipient_type: "individual",
 *     to: <wa_id>, context: { message_id: <wamid> },
 *     type: "text", text: { body } }
 *   → 200 { messages: [{ id: "wamid.…" }] }
 *
 * ⚠️ A 200 MEANS ACCEPTED, NOT DELIVERED. Meta answers with a `wamid` the
 * moment it has taken the message; whether it reached a phone arrives later,
 * on the same webhook field as inbound messages, as a `statuses` entry —
 * `sent`, `delivered`, `read`, or `failed` with an error. The closed
 * 24-hour window (131047), a WABA with no payment method, a person who has
 * blocked the number: all `failed`, all asynchronous. So the caller checks
 * the window BEFORE sending (the thread holds it), and the intake logs every
 * failed status it hears. Nothing here can see those.
 *
 * ⚠️ THE TOKEN IS ONE SYSTEM USER TOKEN FROM THE ENVIRONMENT, AND THAT IS
 * WRITTEN TO BE THE ONE LINE THAT CHANGES. `env.ts` says why. When a
 * connection carries its own business token (the connect screen slice), it
 * is read off `delivery.connection` here and this method never learns the
 * difference.
 *
 * ⚠️ `fetch` IS INJECTED SO A SPEC CAN PROVE THE MAPPING WITHOUT THE NETWORK
 * — the `forwarding-confirmer.ts` precedent. The default is the real one.
 */

/**
 * Graph API version. Pinned, and bumped on purpose: Meta retires a version
 * about two years after release, and an unversioned call floats to whatever
 * is newest, which is how a send that worked on Friday fails on Monday.
 * v25.0 is the version Meta's own partner guide uses as of 2026-06-24.
 */
export const META_GRAPH_VERSION = "v25.0";
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** How long to wait for Meta before treating the send as deferred. */
const TIMEOUT_MS = 15_000;

/**
 * Meta's own codes for "not now" — throughput, the per-pair limit, the spam
 * rate limit, the account in maintenance. Retrying later is right for each.
 */
const DEFERRABLE_CODES = new Set([
  4, // API too many calls
  17, // user request limit reached
  80007, // rate limit on the WABA
  130429, // rate limit hit
  131048, // spam rate limit
  131056, // pair rate limit
  131057, // account in maintenance mode
]);

/** Meta's codes for "this token is no good" — a human has to act. */
const UNUSABLE_CODES = new Set([
  190, // access token invalid or expired
  10, // permission denied
  200, // permissions error (the classic)
  131005, // access denied
]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** DI token for the fetch implementation, so a spec can substitute one. */
export const META_FETCH = Symbol("META_FETCH");

@Injectable()
export class WhatsAppOutboundMessage implements OutboundMessage {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(META_FETCH) private readonly fetchImpl: FetchLike,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppOutboundMessage.name);
  }

  async deliver(delivery: OutboundMessageDelivery): Promise<OutboundMessageReceipt> {
    const token = this.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
      /**
       * ⚠️ DEFERRED, NOT UNUSABLE — the mail port's `UnknownMailProviderError`
       * reasoning. A server with no token is OUR missing piece, not a dead
       * grant, and telling the customer to reconnect something would be
       * advice that can never work. A deploy that carries the token heals it.
       */
      throw new MessageDeliveryDeferredError(
        "not_configured",
        null,
        new Error("WHATSAPP_ACCESS_TOKEN is not configured"),
      );
    }

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: delivery.to,
      type: "text",
      text: { body: delivery.bodyText },
    };
    if (delivery.replyToProviderMessageId) {
      body.context = { message_id: delivery.replyToProviderMessageId };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${META_GRAPH_BASE}/${encodeURIComponent(delivery.connection.phoneNumberId)}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch (error) {
      // A timeout or a refused connection: Meta was not reached, so nothing
      // was sent and nothing is wrong with the message.
      throw new MessageDeliveryDeferredError("unreachable", null, error);
    }

    if (response.ok) {
      const wamid = await readMessageId(response);
      if (!wamid) {
        // Accepted with no id is a shape we have never seen; treat it as a
        // send we cannot prove and let the caller record it as failed rather
        // than invent an id the receipts will never name.
        throw new MessageDeliveryError(response.status, null, "no message id in the response");
      }
      return { providerMessageId: wamid };
    }

    const failure = await readError(response);
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    const retryAfterSeconds = Number.isNaN(retryAfter) ? null : retryAfter;

    if (
      response.status === 429 ||
      response.status >= 500 ||
      (failure.code !== null && DEFERRABLE_CODES.has(failure.code))
    ) {
      throw new MessageDeliveryDeferredError(
        "provider_busy",
        retryAfterSeconds,
        new MessageDeliveryError(response.status, failure.code, failure.title),
      );
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      (failure.code !== null && UNUSABLE_CODES.has(failure.code))
    ) {
      // The code and the title, never the message: Meta's free text can quote
      // request material back, and this line reaches the log.
      this.logger.warn(
        { organisationId: delivery.organisationId, code: failure.code, title: failure.title },
        "Meta refused the WhatsApp access token",
      );
      throw new ChannelUnusableError(
        "the WhatsApp access token was refused",
        new MessageDeliveryError(response.status, failure.code, failure.title),
      );
    }
    throw new MessageDeliveryError(response.status, failure.code, failure.title);
  }
}

async function readMessageId(response: Response): Promise<string | null> {
  try {
    const json = (await response.json()) as { messages?: { id?: unknown }[] };
    const id = json.messages?.[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Meta's error envelope: `{ error: { message, type, code, error_subcode,
 * error_data: { details }, fbtrace_id } }`. Only the code and a short title
 * are kept; `message` and `details` are free text and stay out of our logs.
 */
async function readError(
  response: Response,
): Promise<{ code: number | null; title: string | null }> {
  try {
    const json = (await response.json()) as {
      error?: { code?: unknown; type?: unknown; error_subcode?: unknown };
    };
    const code = typeof json.error?.code === "number" ? json.error.code : null;
    const type = typeof json.error?.type === "string" ? json.error.type : null;
    return { code, title: type };
  } catch {
    return { code: null, title: null };
  }
}
