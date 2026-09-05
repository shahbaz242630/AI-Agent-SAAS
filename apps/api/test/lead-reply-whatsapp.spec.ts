import { createHmac, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant, type EvaPrismaClient } from "@eva/database";
import {
  ChannelUnusableError,
  MessageDeliveryDeferredError,
  type OutboundMessage,
  type OutboundMessageDelivery,
} from "../src/capabilities/messaging/outbound-message.js";
import { phoneFromWaId } from "../src/platform/people/handles.js";
import { addSuppression } from "../src/platform/suppression/suppression.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * Eva answers a WhatsApp enquiry (slice 3.4a) — the whole round trip, from a
 * signed Meta webhook to a message handed to the WhatsApp sender.
 *
 * 🚨 THIS IS THE FILE THAT PROVES THE SECOND CHANNEL. Everything below the
 * webhook — intake, the spine, the lead, the decision, the WhatsApp wording,
 * the thread's window and number, the send, the record, the timeline — runs
 * for real here; only the edge that would put bytes on Meta's wire is stubbed.
 * `lead-reply.spec.ts` proves the same journey by email, and stays as it was.
 *
 * ⚠️ TIMESTAMPS ARE NOW, NOT 2024. The other WhatsApp specs use a fixed 2024
 * clock because nothing they prove depends on it. The reply does: the thread's
 * 24-hour window is `their timestamp + 24h`, and a message from 2024 is a
 * message Eva must NOT answer — which is its own test below.
 */
describe("Eva answers a WhatsApp enquiry", () => {
  const SECRET = "test-meta-app-secret-for-3-4a";
  const VERIFY_TOKEN = "test-verify-token-3-4a";
  const WABA = `waba-${randomUUID().slice(0, 8)}`;
  const PHONE_NUMBER_ID = `pn-${randomUUID().slice(0, 8)}`;
  /** A second number of the same organisation's, whose token has died. */
  const STALE_PHONE_NUMBER_ID = `pn-stale-${randomUUID().slice(0, 8)}`;
  const DISPLAY_NUMBER = "447700900123";

  let app: INestApplication;
  /** The same app with the REAL sender and no token: proves the deferred path end to end. */
  let unconfigured: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;

  /** What Eva handed the sender. One entry per genuine send. */
  let sent: OutboundMessageDelivery[] = [];
  let sendFailure: Error | null = null;
  let lastWamid = "";

  const outboundMessage: OutboundMessage = {
    deliver: async (delivery) => {
      if (sendFailure) throw sendFailure;
      sent.push(delivery);
      lastWamid = `wamid.sent-${randomUUID().slice(0, 8)}`;
      return { providerMessageId: lastWamid };
    },
  };

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    const env = { META_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN };
    app = await createTestApp({ env, outboundMessage });
    unconfigured = await createTestApp({ env });

    org = await createOrgWithMembers(owner, "wa-reply", ["owner"], "Halloway Roofing", [
      { moduleKey: "lead_follow_up" },
    ]);
    await owner.channelConnection.create({
      data: {
        organisationId: org.id,
        moduleKey: "lead_follow_up",
        channel: "whatsapp",
        externalAccountId: WABA,
        externalAssetId: PHONE_NUMBER_ID,
        displayName: "+44 7700 900123",
        connectedBy: org.members[0]!.id,
      },
    });
    await owner.channelConnection.create({
      data: {
        organisationId: org.id,
        moduleKey: "lead_follow_up",
        channel: "whatsapp",
        externalAccountId: WABA,
        externalAssetId: STALE_PHONE_NUMBER_ID,
        displayName: "+44 7700 900124",
        status: "needs_reconnect",
      },
    });

    /**
     * ⚠️ THE WORDINGS ARE SEEDED THE WAY A CUSTOMER SEEDS THEM — by opening
     * the screen. Both channels' defaults appear on that first read.
     */
    const token = await signToken({
      sub: org.members[0]!.authUserId,
      email: org.members[0]!.email,
    });
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/lead-reply-templates`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  beforeEach(() => {
    sent = [];
    sendFailure = null;
  });

  afterAll(async () => {
    await app.close();
    await unconfigured.close();
    await owner.$disconnect();
  });

  const sign = (body: Buffer) =>
    `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

  function webhook(
    messages: Record<string, unknown>[],
    options: { phoneNumberId?: string; contacts?: unknown[] } = {},
  ) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: DISPLAY_NUMBER,
                  phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_ID,
                },
                ...(options.contacts ? { contacts: options.contacts } : {}),
                messages,
              },
            },
          ],
        },
      ],
    };
  }

  /** A fresh number per case: ruling 76 files a second message on the first enquiry. */
  const freshNumber = () => `4479${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  const nowSeconds = () => String(Math.floor(Date.now() / 1000));

  function textMessage(body: string, from: string, extra: Record<string, unknown> = {}) {
    return {
      from,
      id: `wamid.${randomUUID()}`,
      timestamp: nowSeconds(),
      type: "text",
      text: { body },
      ...extra,
    };
  }

  /** A webhook exactly as Meta sends one, signed the way Meta signs it. */
  function post(payload: unknown, target: INestApplication = app) {
    const raw = JSON.stringify(payload);
    return request(target.getHttpServer())
      .post("/integrations/meta/webhook")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", sign(Buffer.from(raw, "utf8")))
      .send(raw);
  }

  const leadFor = (providerMessageId: string) =>
    owner.lead.findFirst({ where: { evidence: { externalId: providerMessageId } } });

  const decisionFor = (leadId: string) =>
    owner.leadReplyDecision.findFirst({ where: { leadId, deletedAt: null } });

  describe("the ordinary enquiry", () => {
    it("replies on WhatsApp, from the number the person wrote to, quoting their message", async () => {
      const from = freshNumber();
      const message = textMessage("Hi, can you quote for a new bathroom?", from);
      await post(webhook([message])).expect(200);

      expect(sent, "Eva sent nothing").toHaveLength(1);
      const delivery = sent[0]!;
      expect(delivery.organisationId).toBe(org.id);
      expect(delivery.to).toBe(from);
      expect(delivery.connection.phoneNumberId).toBe(PHONE_NUMBER_ID);
      expect(delivery.replyToProviderMessageId).toBe(message.id);
      // The customer's own WhatsApp wording, verbatim — not the email one.
      expect(delivery.bodyText).toContain("Thanks for your message");
      expect(delivery.bodyText).not.toContain("email");
    });

    it("records what was sent, by which means, to which number", async () => {
      const from = freshNumber();
      const message = textMessage("Are you open Saturday?", from);
      await post(webhook([message])).expect(200);
      const lead = await leadFor(message.id);
      const decision = await decisionFor(lead!.id);

      expect(decision).toMatchObject({
        verdict: "reply",
        signal: "no-refusal",
        status: "sent",
        channel: "whatsapp",
        // E.164 with the plus — 0039 said this column holds a phone number on WhatsApp.
        toAddress: `+${from}`,
        // The number of ours, as a human knows it.
        sentFrom: "+44 7700 900123",
        subject: null,
      });
      expect(decision!.sentAt).toBeTruthy();
      expect(decision!.templateId).toBeTruthy();
      expect(decision!.body).toBe(sent[0]!.bodyText);
    });

    /**
     * 🔑 THE REPLY IS ON THE TIMELINE WITH META'S ID ON IT. The id is what a
     * delivery receipt names, so the day receipts are stored this is the
     * row they will find.
     */
    it("puts what was sent on the enquiry's thread, as Eva's message, with Meta's id", async () => {
      const from = freshNumber();
      const message = textMessage("Can you come Tuesday?", from);
      await post(webhook([message])).expect(200);
      const lead = await leadFor(message.id);
      const decision = await decisionFor(lead!.id);

      const reply = await owner.message.findFirst({
        where: { sourceTable: "lead_reply_decisions", sourceId: decision!.id },
      });
      expect(reply, "the reply must be a message on the thread").not.toBeNull();
      expect(reply).toMatchObject({
        conversationId: lead!.originConversationId,
        personId: lead!.personId,
        channel: "whatsapp",
        direction: "outbound",
        senderKind: "assistant",
        contentType: "text",
        subject: null,
        bodyText: decision!.body,
        providerMessageId: lastWamid,
      });
      expect(reply!.occurredAt.toISOString()).toBe(decision!.sentAt!.toISOString());

      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: lead!.originConversationId! },
      });
      expect(thread.lastOutboundAt?.toISOString()).toBe(decision!.sentAt!.toISOString());
      const onThread = await owner.message.findMany({
        where: { conversationId: thread.id },
        orderBy: { occurredAt: "asc" },
      });
      expect(onThread.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    });

    it("stamps when the enquiry was first answered", async () => {
      const from = freshNumber();
      const message = textMessage("Hello", from);
      await post(webhook([message])).expect(200);
      expect((await leadFor(message.id))!.firstRespondedAt).toBeTruthy();
    });

    /** A photo of the leak, no words: still somebody reaching out. */
    it("answers a photo with no words", async () => {
      const from = freshNumber();
      const message = {
        from,
        id: `wamid.${randomUUID()}`,
        timestamp: nowSeconds(),
        type: "image",
        image: { id: "media-1", mime_type: "image/jpeg", sha256: "abc" },
      };
      await post(webhook([message])).expect(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(from);
    });
  });

  /**
   * 🚨 THE GUARD THAT MATTERS MOST. Meta retries anything that is not a 200
   * for up to seven days, to every app subscribed to the account.
   */
  describe("a retried delivery", () => {
    it("never sends a stranger the same reply twice", async () => {
      const payload = webhook([textMessage("Once, please", freshNumber())]);
      await post(payload).expect(200);
      expect(sent).toHaveLength(1);

      await post(payload).expect(200);
      expect(sent, "the retry sent a second reply").toHaveLength(1);
    });
  });

  /** Ruling 76, from the stranger's side: a follow-up is not greeted again. */
  describe("a second message on the same thread", () => {
    it("answers the first and stays silent on the follow-up", async () => {
      const from = freshNumber();
      const first = textMessage("First message", from);
      await post(webhook([first])).expect(200);
      expect(sent).toHaveLength(1);

      // A few seconds later by their clock: WhatsApp's timestamps are whole
      // seconds, and the reply went out within the first one.
      const later = String(Math.floor(Date.now() / 1000) + 5);
      await post(webhook([{ ...textMessage("Any update?", from), timestamp: later }])).expect(200);
      expect(sent, "a follow-up was greeted as a new enquiry").toHaveLength(1);

      const lead = await leadFor(first.id);
      expect(await owner.leadReplyDecision.count({ where: { leadId: lead!.id } })).toBe(1);
      const onThread = await owner.message.findMany({
        where: { conversationId: lead!.originConversationId! },
        orderBy: { occurredAt: "asc" },
      });
      expect(onThread.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound"]);
    });
  });

  describe("when Eva decides not to answer", () => {
    it("never answers a reaction, and says why", async () => {
      const from = freshNumber();
      const message = {
        from,
        id: `wamid.${randomUUID()}`,
        timestamp: nowSeconds(),
        type: "reaction",
        reaction: { message_id: "wamid.something", emoji: "👍" },
      };
      await post(webhook([message])).expect(200);

      expect(sent, "Eva answered a thumbs-up").toHaveLength(0);
      const decision = await decisionFor((await leadFor(message.id))!.id);
      expect(decision).toMatchObject({
        verdict: "never",
        signal: "reaction",
        channel: "whatsapp",
        status: "not_sent",
      });
    });

    /** Ruling 32 — the uncertain middle waits for a human. */
    it("holds a chain message for a person to read, and still answers an ordinary forward", async () => {
      const chainFrom = freshNumber();
      const chain = textMessage("FORWARD THIS TO 10 FRIENDS", chainFrom, {
        context: { forwarded: true, frequently_forwarded: true },
      });
      await post(webhook([chain])).expect(200);
      expect(sent).toHaveLength(0);
      const held = await decisionFor((await leadFor(chain.id))!.id);
      expect(held).toMatchObject({ verdict: "hold", signal: "chain-message", status: "not_sent" });

      const forward = textMessage("My wife's photo of the leak", freshNumber(), {
        context: { forwarded: true },
      });
      await post(webhook([forward])).expect(200);
      expect(sent).toHaveLength(1);
    });

    it("still files the enquiry when it does not answer it", async () => {
      const message = {
        from: freshNumber(),
        id: `wamid.${randomUUID()}`,
        timestamp: nowSeconds(),
        type: "reaction",
        reaction: { message_id: "wamid.x", emoji: "❤️" },
      };
      await post(webhook([message])).expect(200);
      const lead = await leadFor(message.id);
      expect(lead).toBeTruthy();
      expect(lead!.firstRespondedAt).toBeNull();
    });

    /**
     * 🚨 RULING 90 (2026-09-05), ON THE SECOND CHANNEL. A phone number only
     * ever goes on the list under `call` — that is the vocabulary — and it
     * covers a WhatsApp from that number: an opt-out is from everything
     * (ruling 79). The entry is written the way `doNotContact` writes one, with
     * the number in the shape the WhatsApp intake stores on the lead.
     */
    it("stays silent to a number that asked not to be contacted, and says why", async () => {
      const from = freshNumber();
      const phone = phoneFromWaId(from)!;
      await withTenant(owner, { organisationId: org.id, userId: org.members[0]!.id }, (tx) =>
        addSuppression(tx, {
          organisationId: org.id,
          channel: "call",
          value: phone,
          reason: "lead_requested",
        }),
      );

      const message = textMessage("Can you come and look at my roof?", from);
      await post(webhook([message])).expect(200);

      expect(sent, "Eva wrote to a number that asked her not to").toHaveLength(0);
      const lead = await leadFor(message.id);
      expect(lead, "the enquiry was not filed").toBeTruthy();
      expect(lead!.contactPhone, "the gate compared a different shape of number").toBe(phone);
      expect(lead!.firstRespondedAt).toBeNull();
      expect(await decisionFor(lead!.id)).toMatchObject({
        verdict: "hold",
        signal: "do_not_contact",
        channel: "whatsapp",
        status: "not_sent",
      });
    });
  });

  /**
   * 🚨 THE 24-HOUR WINDOW. Meta accepts a send outside it and reports the
   * failure later; the thread carries the window, and Eva reads it first.
   */
  describe("the 24-hour window", () => {
    it("stays silent, and says why, when the window has already closed", async () => {
      const from = freshNumber();
      const twoDaysAgo = String(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60);
      const message = { ...textMessage("Sent a while back", from), timestamp: twoDaysAgo };
      await post(webhook([message])).expect(200);

      expect(sent, "Eva replied outside the window").toHaveLength(0);
      const decision = await decisionFor((await leadFor(message.id))!.id);
      expect(decision).toMatchObject({ verdict: "reply", status: "not_sent", channel: "whatsapp" });
      expect(decision!.failureReason).toContain("24-hour window");
    });
  });

  describe("when the send itself fails", () => {
    it("keeps the enquiry and answers 200 when the sender faults", async () => {
      sendFailure = new Error("the sender fell over");
      const message = textMessage("Hello?", freshNumber());
      await post(webhook([message])).expect(200);

      const lead = await leadFor(message.id);
      expect(lead, "the enquiry was lost").toBeTruthy();
      const decision = await decisionFor(lead!.id);
      expect(decision!.status).toBe("failed");
      expect(decision!.failureReason).toBe("the reply could not be sent");
      expect(lead!.firstRespondedAt).toBeNull();
    });

    it("marks a rate limit deferred rather than failed", async () => {
      sendFailure = new MessageDeliveryDeferredError("provider_busy", 30);
      const message = textMessage("Hello?", freshNumber());
      await post(webhook([message])).expect(200);
      const decision = await decisionFor((await leadFor(message.id))!.id);
      expect(decision!.status).toBe("deferred");
      expect(decision!.failureReason).toContain("just now");
    });

    it("says the connection needs attention when the token is refused", async () => {
      sendFailure = new ChannelUnusableError("the WhatsApp access token was refused");
      const message = textMessage("Hello?", freshNumber());
      await post(webhook([message])).expect(200);
      const decision = await decisionFor((await leadFor(message.id))!.id);
      expect(decision!.status).toBe("failed");
      expect(decision!.failureReason).toContain("needs attention");
    });

    /**
     * ⚠️ THROUGH THE REAL SENDER, WITH NO TOKEN — the state of every
     * environment but one until the founder makes a System User token. The
     * reply is recorded as deferred with a sentence that says what is missing,
     * and Meta is never called (the sender refuses before any request).
     */
    it("records the reply as deferred, not set up yet, when this server has no token", async () => {
      const message = textMessage("Hello from a server with no token", freshNumber());
      await post(webhook([message]), unconfigured).expect(200);
      expect(sent).toHaveLength(0);
      const decision = await decisionFor((await leadFor(message.id))!.id);
      expect(decision!.status).toBe("deferred");
      expect(decision!.failureReason).toContain("not set up yet");
    });
  });

  /**
   * The number the person wrote to is the number Eva must answer from. When
   * that number's connection is not usable, no other number is substituted.
   */
  describe("a number that is not connected any more", () => {
    it("files the enquiry and explains why nothing was sent", async () => {
      const message = textMessage("Is this number still yours?", freshNumber());
      await post(webhook([message], { phoneNumberId: STALE_PHONE_NUMBER_ID })).expect(200);

      expect(sent).toHaveLength(0);
      const lead = await leadFor(message.id);
      expect(lead).toBeTruthy();
      const decision = await decisionFor(lead!.id);
      expect(decision).toMatchObject({ verdict: "reply", status: "not_sent", channel: "whatsapp" });
      expect(decision!.failureReason).toContain("not connected");
    });
  });
});
