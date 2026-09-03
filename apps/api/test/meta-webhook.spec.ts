import { createHmac, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  type FixtureOrg,
} from "./support.js";

/**
 * A WhatsApp message reaches Eva and is written down (slice 3.2c).
 *
 * ⚠️ THE SECOND PATH IN THE SYSTEM WITH NO USER BEHIND IT. The caller is Meta,
 * the organisation is DISCOVERED from the number the message was sent to, and
 * the signature is the whole of the authentication. So, as for the mail door,
 * the tests come in three groups:
 *
 *   - what must be refused (the door: the handshake and the signature)
 *   - what must be written down, and for whom (the record)
 *   - what must happen exactly once (the retry)
 *
 * Nothing becomes a lead here; that is 3.3. This slice's proof is "a row
 * appears, in the right organisation, with what the person actually sent".
 */
describe("Meta webhook: a WhatsApp message is written down", () => {
  const SECRET = "test-meta-app-secret-not-a-real-one";
  const VERIFY_TOKEN = "test-verify-token-9f2c";

  // Fresh ids per run: the asset index is unique across the WHOLE table and the
  // test database persists between runs.
  const WABA = `waba-${randomUUID().slice(0, 8)}`;
  const PHONE_NUMBER_ID = `pn-${randomUUID().slice(0, 8)}`;
  const LAPSED_PHONE_NUMBER_ID = `pn-lapsed-${randomUUID().slice(0, 8)}`;

  let app: INestApplication;
  /** The same app with NO secret and NO verify token: the fail-closed control. */
  let unconfigured: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let lapsedOrg: FixtureOrg;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp({
      env: { META_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN },
    });
    unconfigured = await createTestApp();

    org = await createOrgWithMembers(owner, "meta", ["owner"], "Halloway Roofing", [
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
      },
    });

    lapsedOrg = await createOrgWithMembers(owner, "meta-lapsed", ["owner"], "Lapsed Trading", [
      { moduleKey: "lead_follow_up" },
    ]);
    await owner.channelConnection.create({
      data: {
        organisationId: lapsedOrg.id,
        moduleKey: "lead_follow_up",
        channel: "whatsapp",
        externalAccountId: WABA,
        externalAssetId: LAPSED_PHONE_NUMBER_ID,
      },
    });
    // The number outlives the entitlement; switched off AFTER connecting, the
    // only way this state can arise.
    await owner.organisationModule.updateMany({
      where: { organisationId: lapsedOrg.id },
      data: { enabled: false },
    });
  });

  afterAll(async () => {
    await app.close();
    await unconfigured.close();
    await owner.$disconnect();
  });

  const sign = (secret: string, body: Buffer) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  function webhook(
    messages: Record<string, unknown>[],
    options: { phoneNumberId?: string; contacts?: unknown[]; statuses?: unknown[] } = {},
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
                  display_phone_number: "447700900123",
                  phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_ID,
                },
                ...(options.contacts ? { contacts: options.contacts } : {}),
                ...(messages.length ? { messages } : {}),
                ...(options.statuses ? { statuses: options.statuses } : {}),
              },
            },
          ],
        },
      ],
    };
  }

  function textMessage(body: string, from = "447911123456") {
    return {
      from,
      id: `wamid.${randomUUID()}`,
      timestamp: "1725370800",
      type: "text",
      text: { body },
    };
  }

  /** A webhook exactly as Meta sends one, signed the way Meta signs it. */
  function post(
    target: INestApplication,
    payload: unknown,
    options: { secret?: string; signature?: string | null } = {},
  ) {
    /**
     * ⚠️ SENT AS A STRING, NOT A BUFFER — the lesson the Resend spec learned:
     * superagent JSON-serialises a Buffer into `{"type":"Buffer",…}` and the
     * HMAC can never match.
     */
    const raw = JSON.stringify(payload);
    const body = Buffer.from(raw, "utf8");
    const signature =
      options.signature === null
        ? undefined
        : (options.signature ?? sign(options.secret ?? SECRET, body));
    let req = request(target.getHttpServer())
      .post("/integrations/meta/webhook")
      .set("Content-Type", "application/json");
    if (signature) req = req.set("x-hub-signature-256", signature);
    return req.send(raw);
  }

  describe("the handshake (the door, GET)", () => {
    it("echoes the challenge verbatim as plain text when the token matches", async () => {
      const response = await request(app.getHttpServer())
        .get("/integrations/meta/webhook")
        .query({
          "hub.mode": "subscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "1158201444",
        })
        .expect(200);
      // Byte for byte: Meta compares the body to the string it sent.
      expect(response.text).toBe("1158201444");
      expect(response.headers["content-type"]).toMatch(/^text\/plain/);
    });

    it("refuses the wrong token", async () => {
      await request(app.getHttpServer())
        .get("/integrations/meta/webhook")
        .query({ "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1" })
        .expect(403);
    });

    it("refuses a request that is not a subscribe", async () => {
      await request(app.getHttpServer())
        .get("/integrations/meta/webhook")
        .query({
          "hub.mode": "unsubscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "1",
        })
        .expect(403);
    });

    /**
     * 🚨 THE REFLECTED VALUE. CodeQL flagged the echo (`js/reflected-xss`) on
     * PR #136. A correct token with a challenge carrying markup is refused —
     * not escaped, refused — and the successful echo carries `nosniff` so a
     * browser cannot second-guess the plain-text content type.
     */
    it("refuses a challenge carrying markup even with the right token, and marks the echo nosniff", async () => {
      const response = await request(app.getHttpServer())
        .get("/integrations/meta/webhook")
        .query({
          "hub.mode": "subscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "<script>alert(1)</script>",
        })
        .expect(403);
      expect(response.text).not.toContain("<script>");

      const ok = await request(app.getHttpServer())
        .get("/integrations/meta/webhook")
        .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "42" })
        .expect(200);
      expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("refuses everything when no verify token is configured — even the empty token", async () => {
      await request(unconfigured.getHttpServer())
        .get("/integrations/meta/webhook")
        .query({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" })
        .expect(403);
    });
  });

  describe("the signature (the door, POST)", () => {
    it("refuses a webhook with no signature", async () => {
      await post(app, webhook([textMessage("hello")]), { signature: null }).expect(401);
    });

    it("refuses a webhook signed with a different secret", async () => {
      await post(app, webhook([textMessage("hello")]), { secret: "not-our-secret" }).expect(401);
    });

    it("refuses a webhook whose body changed after signing", async () => {
      const signed = sign(SECRET, Buffer.from(JSON.stringify(webhook([textMessage("a")]))));
      await post(app, webhook([textMessage("b")]), { signature: signed }).expect(401);
    });

    /**
     * ⚠️ THE FAIL-CLOSED CONTROL. A correctly signed webhook against an app
     * with no secret must still be refused; "no secret, skip the check" is the
     * defect this proves absent.
     */
    it("refuses everything when META_APP_SECRET is not configured", async () => {
      await post(unconfigured, webhook([textMessage("hello")])).expect(401);
    });
  });

  describe("the record", () => {
    it("writes a text message down, in the organisation that owns the number", async () => {
      const message = textMessage("Hi, my roof is leaking above the kitchen.");
      const response = await post(
        app,
        webhook([message], {
          contacts: [{ profile: { name: "Jane Smith" }, wa_id: "447911123456" }],
        }),
      ).expect(200);
      expect(response.body).toMatchObject({ status: "received", stored: 1, duplicates: 0 });

      const rows = await owner.inboundChannelMessage.findMany({
        where: { providerMessageId: message.id },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        organisationId: org.id,
        channel: "whatsapp",
        fromIdentifier: "447911123456",
        fromDisplayName: "Jane Smith",
        messageType: "text",
        textBody: "Hi, my roof is leaking above the kitchen.",
        status: "received",
        failureReason: null,
        leadId: null,
      });
      expect(row.receivedAt.toISOString()).toBe("2024-09-03T13:40:00.000Z");
      expect((row.payload as { message: unknown }).message).toEqual(message);
    });

    /**
     * 🚨 THE CASE THAT IS INVISIBLE ON A UK TEST BENCH. Meta signs an
     * escaped-unicode rendering; hashing the raw bytes is what makes this
     * pass, and a re-serialising guard would fail it — only for customers
     * whose enquirers do not write in ASCII.
     */
    it("accepts and stores a non-ASCII message exactly", async () => {
      const body = "مرحبا، أحتاج سباكاً اليوم 🔧 — Zoë Müller";
      const message = textMessage(body, "971501234567");
      await post(app, webhook([message])).expect(200);
      const row = await owner.inboundChannelMessage.findFirst({
        where: { providerMessageId: message.id },
      });
      expect(row?.textBody).toBe(body);
    });

    it("stores a photo with no words as its own type, with a null body", async () => {
      const message = {
        from: "447911123456",
        id: `wamid.${randomUUID()}`,
        timestamp: "1725370800",
        type: "image",
        image: { id: "media-1", mime_type: "image/jpeg", sha256: "abc" },
      };
      await post(app, webhook([message])).expect(200);
      const row = await owner.inboundChannelMessage.findFirst({
        where: { providerMessageId: message.id },
      });
      expect(row).toMatchObject({ messageType: "image", textBody: null });
    });

    it("stores every message in a batch", async () => {
      const first = textMessage("one");
      const second = textMessage("two");
      const response = await post(app, webhook([first, second])).expect(200);
      expect(response.body).toMatchObject({ status: "received", stored: 2 });
      const rows = await owner.inboundChannelMessage.findMany({
        where: { providerMessageId: { in: [first.id, second.id] } },
      });
      expect(rows).toHaveLength(2);
    });

    it("keeps a message for a lapsed organisation, marked ignored with the reason", async () => {
      const message = textMessage("still here", "447700111222");
      const response = await post(
        app,
        webhook([message], { phoneNumberId: LAPSED_PHONE_NUMBER_ID }),
      ).expect(200);
      expect(response.body).toMatchObject({ status: "ignored", stored: 0, ignored: 1 });
      const row = await owner.inboundChannelMessage.findFirst({
        where: { providerMessageId: message.id },
      });
      expect(row).toMatchObject({
        organisationId: lapsedOrg.id,
        status: "ignored",
        failureReason: "organisation does not hold lead_follow_up",
      });
    });

    it("acknowledges a message for a number nobody connected, and stores nothing", async () => {
      const message = textMessage("wrong door");
      const response = await post(
        app,
        webhook([message], { phoneNumberId: `pn-unknown-${randomUUID().slice(0, 8)}` }),
      ).expect(200);
      expect(response.body).toMatchObject({ status: "unroutable", unroutable: 1, stored: 0 });
      expect(
        await owner.inboundChannelMessage.count({ where: { providerMessageId: message.id } }),
      ).toBe(0);
    });

    it("acknowledges delivery receipts without storing them", async () => {
      const response = await post(
        app,
        webhook([], {
          statuses: [{ id: "wamid.sent", status: "delivered", timestamp: "1", recipient_id: "1" }],
        }),
      ).expect(200);
      expect(response.body).toMatchObject({
        status: "not-applicable",
        statusUpdates: 1,
        stored: 0,
      });
    });

    it("acknowledges another Meta object without storing anything", async () => {
      const response = await post(app, { object: "page", entry: [] }).expect(200);
      expect(response.body).toMatchObject({ status: "not-applicable", stored: 0 });
    });

    it("acknowledges a shape it cannot read rather than asking Meta to retry it", async () => {
      const response = await post(app, { object: "whatsapp_business_account", entry: "?" }).expect(
        200,
      );
      expect(response.body).toMatchObject({ status: "not-applicable" });
    });
  });

  describe("exactly once (the retry)", () => {
    /**
     * ⚠️ THE ORDINARY CASE, NOT THE EDGE. Meta retries for up to seven days and
     * delivers to every app subscribed to the account. The second delivery is
     * a 200 that stores nothing.
     */
    it("stores a message once however many times Meta delivers it", async () => {
      const message = textMessage("only once");
      const payload = webhook([message]);

      const first = await post(app, payload).expect(200);
      expect(first.body).toMatchObject({ status: "received", stored: 1 });

      for (let i = 0; i < 2; i += 1) {
        const again = await post(app, payload).expect(200);
        expect(again.body).toMatchObject({ status: "duplicate", stored: 0, duplicates: 1 });
      }

      expect(
        await owner.inboundChannelMessage.count({ where: { providerMessageId: message.id } }),
      ).toBe(1);
    });

    it("stores only the new message when a retry carries one old and one new", async () => {
      const old = textMessage("old");
      await post(app, webhook([old])).expect(200);
      const fresh = textMessage("new");
      const response = await post(app, webhook([old, fresh])).expect(200);
      expect(response.body).toMatchObject({ status: "received", stored: 1, duplicates: 1 });
    });
  });
});
