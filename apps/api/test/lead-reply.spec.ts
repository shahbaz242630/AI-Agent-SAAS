import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { signForTest } from "../src/capabilities/mailbox/inbound/resend-webhook-signature.js";
import type { ReceivedMail } from "../src/capabilities/mailbox/inbound/received-mail.js";
import type {
  OutboundMail,
  OutboundMailDelivery,
} from "../src/capabilities/mailbox/outbound-mail.js";
import {
  MailboxUnusableError,
  MailDeliveryDeferredError,
} from "../src/capabilities/mailbox/outbound-mail.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  TEST_RESEND_WEBHOOK_SECRET,
  type FixtureOrg,
} from "./support.js";

/**
 * Eva answers an enquiry (slice 3.1c-3) — the whole round trip, from a signed
 * Resend webhook to a message handed to the mail provider.
 *
 * 🚨 THIS IS THE FILE THAT PROVES THE PRODUCT DOES WHAT ITS BLURB SAYS. Lead
 * Follow-up has promised "answers new enquiries from your mailbox"
 * since 3.1a and has been unable to answer anything. Everything below the
 * webhook — intake, the lead, the decision, the template, the mailbox
 * resolution, the send, the record — runs for real here; only the two edges of
 * the system are stubbed (the message fetch, and the provider that would put
 * bytes on the wire).
 *
 * ⚠️ AND THE THING MOST WORTH GUARDING IS THE SECOND SEND. Resend retries a
 * webhook that does not answer 200, so without the idempotency key a stranger
 * gets the same automatic reply twice, in the customer's name, and the customer
 * finds out from them.
 */
describe("Eva answers an enquiry", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let address: string;

  /** What Eva handed the provider. One entry per genuine send. */
  let sent: OutboundMailDelivery[] = [];
  /** Set by a test to make the provider fail in a particular way. */
  let sendFailure: Error | null = null;

  const outboundMail: OutboundMail = {
    deliver: async (delivery) => {
      if (sendFailure) throw sendFailure;
      sent.push(delivery);
    },
  };

  /** The message intake fetches after the webhook names it. */
  let inbound: {
    from: string;
    subject: string | null;
    text: string;
    html: string | null;
    headers: Record<string, string>;
  };

  const receivedMail: ReceivedMail = {
    fetch: async () => inbound,
  };

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp({ receivedMail, outboundMail });
    org = await createOrgWithMembers(owner, "reply", ["owner"], "Halloway Roofing", [
      { moduleKey: "lead_follow_up" },
    ]);

    const token = await signToken({
      sub: org.members[0]!.authUserId,
      email: org.members[0]!.email,
    });
    address = (
      await request(app.getHttpServer())
        .get(`/organisations/${org.id}/inbound-address`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200)
    ).body.address as string;

    /**
     * ⚠️ THE TEMPLATES ARE SEEDED THE WAY A CUSTOMER SEEDS THEM — by opening
     * the screen. The reply path deliberately does NOT create them (a webhook
     * must not write a customer's default wording as a side effect of a
     * stranger sending mail), so a spec that inserted them directly would prove
     * a path no customer ever takes.
     */
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/lead-reply-templates`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    /** A mailbox for the LEAD product — ruling 36, mailboxes belong to one. */
    await owner.emailAccount.create({
      data: {
        organisationId: org.id,
        moduleKey: "lead_follow_up",
        provider: "google",
        emailAddress: "office@hallowayroofing.co.uk",
        isPrimary: true,
        healthStatus: "active",
        connectedBy: org.members[0]!.id,
        accessTokenEncrypted: "v1.stub",
        refreshTokenEncrypted: "v1.stub",
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
      },
    });
  });

  beforeEach(() => {
    sent = [];
    sendFailure = null;
    inbound = {
      from: "Dave Nolan <dave.nolan@example.com>",
      subject: "Leaking roof above the kitchen",
      text: "Hello, my roof is leaking above the kitchen. Could you take a look this week?",
      html: null,
      headers: { "message-id": "<abc@example.com>", "x-ses-spam-verdict": "PASS" },
    };
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /** A webhook exactly as Resend sends one, signed the way Resend signs it. */
  function post(payload: unknown, id = `msg_${Math.random().toString(36).slice(2)}`) {
    const raw = JSON.stringify(payload);
    const body = Buffer.from(raw, "utf8");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return request(app.getHttpServer())
      .post("/integrations/resend/inbound")
      .set("svix-id", id)
      .set("svix-timestamp", timestamp)
      .set("svix-signature", signForTest(TEST_RESEND_WEBHOOK_SECRET, id, timestamp, body))
      .set("Content-Type", "application/json")
      .send(raw);
  }

  const enquiry = (emailId = `re_${Math.random().toString(36).slice(2)}`) => ({
    type: "email.received",
    data: {
      email_id: emailId,
      from: "dave.nolan@example.com",
      to: [address],
      received_for: [address],
      subject: inbound.subject,
      created_at: new Date().toISOString(),
    },
  });

  const decisionFor = async (leadId: string) =>
    await owner.leadReplyDecision.findFirst({ where: { leadId, deletedAt: null } });

  const leadFrom = async (email: string) =>
    await owner.lead.findFirst({
      where: { organisationId: org.id, contactEmail: email },
      orderBy: { createdAt: "desc" },
    });

  describe("the ordinary enquiry", () => {
    it("replies, from the lead product's own mailbox", async () => {
      await post(enquiry()).expect(200);

      expect(sent, "Eva sent nothing").toHaveLength(1);
      const delivery = sent[0]!;
      expect(delivery.to).toBe("dave.nolan@example.com");
      expect(delivery.subject).toBe("Re: Leaking roof above the kitchen");
      expect(delivery.account.emailAddress).toBe("office@hallowayroofing.co.uk");
      // The customer's own template wording, verbatim.
      expect(delivery.bodyText).toContain("Thanks for getting in touch");
    });

    it("records what was sent, so it can be answered for later", async () => {
      await post(enquiry()).expect(200);
      const lead = await leadFrom("dave.nolan@example.com");
      const decision = await decisionFor(lead!.id);

      expect(decision).toBeTruthy();
      expect(decision!.verdict).toBe("reply");
      expect(decision!.status).toBe("sent");
      expect(decision!.toAddress).toBe("dave.nolan@example.com");
      expect(decision!.sentFrom).toBe("office@hallowayroofing.co.uk");
      expect(decision!.sentAt).toBeTruthy();
      expect(decision!.templateId).toBeTruthy();
      /**
       * ⚠️ THE BODY IS STORED, NOT JUST THE TEMPLATE ID. A customer edits their
       * templates freely, so the template's wording today is not what was sent
       * last month — and this row is the record of what a stranger received.
       */
      expect(decision!.body).toBe(sent[0]!.bodyText);
    });

    /**
     * ⚠️ SPEED-TO-LEAD IS THE NUMBER THIS PRODUCT EXISTS TO MAKE SMALL, and
     * this column has existed unused since 3.1a. Nothing else sets it.
     */
    it("stamps when the enquiry was first answered", async () => {
      await post(enquiry()).expect(200);
      const lead = await leadFrom("dave.nolan@example.com");
      expect(lead!.firstRespondedAt).toBeTruthy();
    });
  });

  /**
   * 🚨 THE GUARD THAT MATTERS MOST. Resend retries a webhook that does not
   * answer 200 — "immediately, then a few more times over the next 36 hours".
   */
  describe("a retried delivery", () => {
    it("never sends a stranger the same reply twice", async () => {
      const payload = enquiry();
      const id = "msg_retried";
      await post(payload, id).expect(200);
      expect(sent).toHaveLength(1);

      // The identical delivery, exactly as Resend would resend it.
      await post(payload, id).expect(200);
      expect(sent, "the retry sent a second reply").toHaveLength(1);

      const lead = await leadFrom("dave.nolan@example.com");
      const decisions = await owner.leadReplyDecision.count({ where: { leadId: lead!.id } });
      expect(decisions).toBe(1);
    });
  });

  describe("when Eva decides not to answer", () => {
    it("stays silent on an auto-responder, and says why", async () => {
      inbound.headers = { ...inbound.headers, "auto-submitted": "auto-replied" };
      await post(enquiry()).expect(200);

      expect(sent, "Eva answered a machine").toHaveLength(0);
      const lead = await leadFrom("dave.nolan@example.com");
      const decision = await decisionFor(lead!.id);
      expect(decision!.verdict).toBe("never");
      expect(decision!.status).toBe("not_sent");
      expect(decision!.reason).toContain("loop");
    });

    /** Ruling 32 — the uncertain middle waits for a human. */
    it("holds an uncertain one for a person to read", async () => {
      inbound.headers = { ...inbound.headers, "x-ses-spam-verdict": "GRAY" };
      await post(enquiry()).expect(200);

      expect(sent).toHaveLength(0);
      const lead = await leadFrom("dave.nolan@example.com");
      const decision = await decisionFor(lead!.id);
      expect(decision!.verdict).toBe("hold");
      expect(decision!.status).toBe("not_sent");
    });

    /**
     * ⚠️ `not_sent` IS A SUCCESS. The enquiry is still filed and still visible;
     * only the automatic answer was withheld. If this ever started marking the
     * delivery failed, a customer's screen would fill with red for the product
     * working exactly as designed.
     */
    it("still files the enquiry when it does not answer it", async () => {
      inbound.headers = { ...inbound.headers, "auto-submitted": "auto-generated" };
      await post(enquiry()).expect(200);
      const lead = await leadFrom("dave.nolan@example.com");
      expect(lead).toBeTruthy();
      expect(lead!.firstRespondedAt).toBeNull();
    });
  });

  describe("when the send itself fails", () => {
    /**
     * ⚠️ THE ENQUIRY MUST SURVIVE A FAILED REPLY. The webhook has already
     * stored it by the time Eva tries to answer; losing an enquiry because we
     * could not answer it would be far worse than not answering.
     */
    it("keeps the enquiry and answers 200 when the provider refuses", async () => {
      sendFailure = new Error("the provider fell over");
      await post(enquiry()).expect(200);

      const lead = await leadFrom("dave.nolan@example.com");
      expect(lead, "the enquiry was lost").toBeTruthy();
      const decision = await decisionFor(lead!.id);
      expect(decision!.status).toBe("failed");
      expect(lead!.firstRespondedAt).toBeNull();
    });

    /**
     * ⚠️ DEFERRED IS NOT FAILED, AND COLLAPSING THEM LOSES MAIL. `outbound-mail.ts`
     * records the 1.7 lesson: treating every provider error as terminal binned
     * reminders on a 429 — which only happens under load.
     */
    it("marks a rate limit deferred rather than failed", async () => {
      sendFailure = new MailDeliveryDeferredError(30);
      await post(enquiry()).expect(200);
      const lead = await leadFrom("dave.nolan@example.com");
      expect((await decisionFor(lead!.id))!.status).toBe("deferred");
    });

    it("says the mailbox needs reconnecting when that is the problem", async () => {
      sendFailure = new MailboxUnusableError();
      await post(enquiry()).expect(200);
      const lead = await leadFrom("dave.nolan@example.com");
      const decision = await decisionFor(lead!.id);
      expect(decision!.status).toBe("failed");
      expect(decision!.failureReason).toContain("reconnecting");
    });
  });

  /**
   * ⚠️ AN ORGANISATION WITH NO MAILBOX IS THE ORDINARY STATE OF A NEW CUSTOMER,
   * not an edge case — onboarding stopped connecting one (ruling 53). It must
   * file the enquiry and explain the silence, never fail.
   */
  describe("an organisation that cannot send yet", () => {
    let unequipped: FixtureOrg;
    let unequippedAddress: string;

    beforeAll(async () => {
      unequipped = await createOrgWithMembers(owner, "reply-nomailbox", ["owner"], undefined, [
        { moduleKey: "lead_follow_up" },
      ]);
      const token = await signToken({
        sub: unequipped.members[0]!.authUserId,
        email: unequipped.members[0]!.email,
      });
      unequippedAddress = (
        await request(app.getHttpServer())
          .get(`/organisations/${unequipped.id}/inbound-address`)
          .set("Authorization", `Bearer ${token}`)
          .expect(200)
      ).body.address as string;
      await request(app.getHttpServer())
        .get(`/organisations/${unequipped.id}/lead-reply-templates`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    it("files the enquiry and explains why nothing was sent", async () => {
      await post({
        type: "email.received",
        data: {
          email_id: `re_${Math.random().toString(36).slice(2)}`,
          from: "dave.nolan@example.com",
          to: [unequippedAddress],
          received_for: [unequippedAddress],
          subject: inbound.subject,
          created_at: new Date().toISOString(),
        },
      }).expect(200);

      expect(sent).toHaveLength(0);
      const lead = await owner.lead.findFirst({
        where: { organisationId: unequipped.id },
        orderBy: { createdAt: "desc" },
      });
      expect(lead).toBeTruthy();
      const decision = await decisionFor(lead!.id);
      expect(decision!.verdict).toBe("reply");
      expect(decision!.status).toBe("not_sent");
      expect(decision!.failureReason).toContain("no mailbox");
    });
  });
});
