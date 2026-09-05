import { describe, expect, it } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import {
  ChannelUnusableError,
  MessageDeliveryDeferredError,
  MessageDeliveryError,
  type OutboundMessageDelivery,
} from "../outbound-message.js";
import { META_GRAPH_BASE, WhatsAppOutboundMessage, type FetchLike } from "./whatsapp-outbound.js";

/**
 * Sending on WhatsApp without touching Meta (slice 3.4a).
 *
 * ⚠️ THE REQUEST SHAPE IS META'S DOCUMENTED ONE, CHECKED FIELD BY FIELD, and
 * the error mapping is the whole reason the port has three outcomes. A
 * sender that treated every non-200 as `failed` would pass a happy-path test
 * and bin replies on the first rate limit — the mail port's 1.7 lesson.
 */

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: Call[];
  fetch: FetchLike;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Meta's error envelope, as documented. The message quotes something back on purpose. */
function metaError(status: number, code: number, type = "OAuthException"): Response {
  return json(status, {
    error: {
      message: `(#${code}) something with the number +447700900123 in it`,
      type,
      code,
      error_data: { details: "the recipient's number again" },
      fbtrace_id: "AbCdEf",
    },
  });
}

const env = { WHATSAPP_ACCESS_TOKEN: "test-system-user-token" } as ApiEnv; // gitleaks:allow — fake

const logger = {
  setContext: () => undefined,
  warn: () => undefined,
} as unknown as ConstructorParameters<typeof WhatsAppOutboundMessage>[2];

const delivery: OutboundMessageDelivery = {
  organisationId: "org-1",
  connection: { id: "conn-1", phoneNumberId: "106540352242922" },
  to: "447700900123",
  bodyText: "Thanks for your message — we've got it.",
  replyToProviderMessageId: "wamid.the-enquiry",
};

function sender(fetchImpl: FetchLike, overrides: Partial<ApiEnv> = {}) {
  return new WhatsAppOutboundMessage({ ...env, ...overrides }, fetchImpl, logger);
}

describe("WhatsAppOutboundMessage: the request", () => {
  it("posts Meta's contextual text reply to the number's messages endpoint", async () => {
    const { calls, fetch } = stubFetch(() =>
      json(200, { messaging_product: "whatsapp", messages: [{ id: "wamid.sent" }] }),
    );
    const receipt = await sender(fetch).deliver(delivery);

    expect(receipt).toEqual({ providerMessageId: "wamid.sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${META_GRAPH_BASE}/106540352242922/messages`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-system-user-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "447700900123",
      context: { message_id: "wamid.the-enquiry" },
      type: "text",
      text: { body: "Thanks for your message — we've got it." },
    });
    expect(calls[0]!.init.signal, "every call carries a timeout").toBeInstanceOf(AbortSignal);
  });

  it("sends a plain message when there is nothing to quote", async () => {
    const { calls, fetch } = stubFetch(() => json(200, { messages: [{ id: "wamid.sent" }] }));
    await sender(fetch).deliver({ ...delivery, replyToProviderMessageId: null });
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty("context");
  });

  it("keeps non-ASCII text exactly", async () => {
    const { calls, fetch } = stubFetch(() => json(200, { messages: [{ id: "wamid.sent" }] }));
    await sender(fetch).deliver({ ...delivery, bodyText: "شكراً — we've got it ✅" });
    expect(JSON.parse(String(calls[0]!.init.body)).text.body).toBe("شكراً — we've got it ✅");
  });

  /** Accepted with no id is a send nobody can prove; it must not be recorded as sent. */
  it("treats a 200 with no message id as a failure rather than inventing one", async () => {
    const { fetch } = stubFetch(() => json(200, { messages: [] }));
    await expect(sender(fetch).deliver(delivery)).rejects.toBeInstanceOf(MessageDeliveryError);
  });
});

describe("WhatsAppOutboundMessage: the three outcomes", () => {
  /**
   * ⚠️ NOT UNUSABLE. A server with no token is OUR missing piece; telling the
   * customer to reconnect something would be advice that can never work.
   */
  it("defers, as not configured, when there is no token — and never calls Meta", async () => {
    const { calls, fetch } = stubFetch(() => json(200, { messages: [{ id: "wamid.sent" }] }));
    const error = await sender(fetch, { WHATSAPP_ACCESS_TOKEN: "" })
      .deliver(delivery)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessageDeliveryDeferredError);
    expect((error as MessageDeliveryDeferredError).detail).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("defers on a rate limit, surfacing Retry-After", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 130429, type: "OAuthException" } }), {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );
    const error = await sender(fetch)
      .deliver(delivery)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessageDeliveryDeferredError);
    expect((error as MessageDeliveryDeferredError).detail).toBe("provider_busy");
    expect((error as MessageDeliveryDeferredError).retryAfterSeconds).toBe(30);
  });

  it("defers on a 5xx", async () => {
    const { fetch } = stubFetch(() => json(503, { error: { code: 2, type: "OAuthException" } }));
    await expect(sender(fetch).deliver(delivery)).rejects.toBeInstanceOf(
      MessageDeliveryDeferredError,
    );
  });

  /** Meta's own "not now" codes can arrive on a 400. */
  it("defers on Meta's throughput and pair-rate-limit codes even on a 400", async () => {
    for (const code of [131056, 131048, 80007, 131057]) {
      const { fetch } = stubFetch(() => metaError(400, code));
      const error = await sender(fetch)
        .deliver(delivery)
        .catch((e: unknown) => e);
      expect(error, String(code)).toBeInstanceOf(MessageDeliveryDeferredError);
    }
  });

  it("defers when Meta cannot be reached at all", async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await sender(fetch)
      .deliver(delivery)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessageDeliveryDeferredError);
    expect((error as MessageDeliveryDeferredError).detail).toBe("unreachable");
  });

  it("marks the channel unusable when the token is refused", async () => {
    for (const [status, code] of [
      [401, 190],
      [403, 10],
      [400, 200],
      [400, 131005],
    ] as const) {
      const { fetch } = stubFetch(() => metaError(status, code));
      const error = await sender(fetch)
        .deliver(delivery)
        .catch((e: unknown) => e);
      expect(error, `${status}/${code}`).toBeInstanceOf(ChannelUnusableError);
    }
  });

  /** The case that must fail: a bad request is ours, and retrying it is pointless. */
  it("fails outright on any other refusal, carrying the code and never the body", async () => {
    const { fetch } = stubFetch(() => metaError(400, 131009));
    const error = await sender(fetch)
      .deliver(delivery)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessageDeliveryError);
    expect((error as MessageDeliveryError).code).toBe(131009);
    expect((error as MessageDeliveryError).status).toBe(400);
    expect((error as MessageDeliveryError).message).not.toContain("447700900123");
    expect((error as MessageDeliveryError).message).not.toContain("recipient's number");
  });

  it("fails outright, not deferred, on a 4xx with no readable error body", async () => {
    const { fetch } = stubFetch(() => new Response("not json", { status: 400 }));
    await expect(sender(fetch).deliver(delivery)).rejects.toBeInstanceOf(MessageDeliveryError);
  });
});
