import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { signForTest } from "../src/capabilities/mailbox/inbound/resend-webhook-signature.js";
import type {
  ReceivedMail,
  ReceivedMessage,
} from "../src/capabilities/mailbox/inbound/received-mail.js";
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
 * An enquiry emailed to Eva becomes a lead (Slice 3.1b, ruling 29).
 *
 * ⚠️ THIS IS THE FIRST PATH IN THE SYSTEM WITH NO USER BEHIND IT. Every other
 * write is made by somebody who signed in, named their organisation in the URL
 * and proved membership. Here the caller is a mail service, the organisation is
 * DISCOVERED from the address the mail was delivered to, and the signature is
 * the whole of the authentication. So the tests come in three groups:
 *
 *   - what must be refused (the door)
 *   - what must be kept even when things go wrong (the record)
 *   - what must happen exactly once (the lead)
 *
 * ⚠️ THE THIRD GROUP IS THE ONE THAT BITES. Webhooks retry: on a non-2xx, on a
 * timeout, and on successes the sender never heard about. "One enquiry, one
 * lead" is not a property of the happy path — it is a property of the path
 * where the same message is delivered three times while the fetch is failing.
 */
describe("Inbound webhook: an email becomes an enquiry", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let unentitledOrg: FixtureOrg;
  let address: string;
  let unentitledAddress: string;
  /**
   * ⚠️ A FRESH SENDER PER TEST, SINCE 3.3b. Ruling 76: a second message from
   * the same address on an open thread is filed on the enquiry already being
   * worked, not made into a new one. Every case in this file is about a FIRST
   * enquiry, so each gets its own stranger; the ruling itself is proved at
   * the bottom, deliberately, with the same sender twice.
   */
  let sender: string;

  /** What the stubbed Resend fetch returns next, and what it was asked for. */
  let nextMessage: ReceivedMessage;
  let fetchFails: Error | null = null;
  const fetched: string[] = [];

  const receivedMail: ReceivedMail = {
    async fetch(providerMessageId: string): Promise<ReceivedMessage> {
      fetched.push(providerMessageId);
      if (fetchFails) throw fetchFails;
      return nextMessage;
    },
  };

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp({ receivedMail });

    org = await createOrgWithMembers(owner, "inbound", ["owner"], "Halloway Roofing", [
      { moduleKey: "lead_follow_up" },
    ]);
    address = await issueAddress(org);

    unentitledOrg = await createOrgWithMembers(
      owner,
      "inbound-lapsed",
      ["owner"],
      "Lapsed Trading",
      [{ moduleKey: "lead_follow_up" }],
    );
    unentitledAddress = await issueAddress(unentitledOrg);
    /**
     * The address outlives the entitlement — a customer can stop paying while
     * their address is still printed on their website. Switched off AFTER the
     * door was opened, which is the only way this state can arise.
     */
    await owner.organisationModule.updateMany({
      where: { organisationId: unentitledOrg.id },
      data: { enabled: false },
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(() => {
    fetchFails = null;
    fetched.length = 0;
    sender = `jane-${Math.random().toString(36).slice(2, 8)}@example.com`;
    nextMessage = {
      from: `Jane Smith <${sender}>`,
      subject: "Leaking roof",
      text: "Hello, my roof is leaking above the kitchen. Can someone come out this week?",
      html: "<p>Hello, my roof is leaking above the kitchen.</p>",
      headers: { "message-id": "<abc@example.com>", received: "from mail.example.com" },
    };
  });

  async function issueAddress(fixture: FixtureOrg): Promise<string> {
    const token = await signToken({
      sub: fixture.members[0]!.authUserId,
      email: fixture.members[0]!.email,
    });
    const response = await request(app.getHttpServer())
      .get(`/organisations/${fixture.id}/inbound-address`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return response.body.address as string;
  }

  /** A webhook exactly as Resend sends one, signed the way Resend signs it. */
  function post(
    payload: unknown,
    options: { secret?: string; timestamp?: string; signature?: string; id?: string } = {},
  ) {
    /**
     * ⚠️ SENT AS A STRING, NOT A BUFFER. Superagent serialises according to
     * Content-Type: hand it a Buffer with `application/json` and it
     * JSON-stringifies the Buffer itself, so what goes on the wire is
     * `{"type":"Buffer","data":[123,34,...]}` and the HMAC can never match.
     * Every genuine webhook came back 401 — the exact failure the signature
     * module warns about, arriving through the test harness rather than the code.
     */
    const raw = JSON.stringify(payload);
    const body = Buffer.from(raw, "utf8");
    const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}`;
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
    const signature =
      options.signature ??
      signForTest(options.secret ?? TEST_RESEND_WEBHOOK_SECRET, id, timestamp, body);

    return request(app.getHttpServer())
      .post("/integrations/resend/inbound")
      .set("svix-id", id)
      .set("svix-timestamp", timestamp)
      .set("svix-signature", signature)
      .set("Content-Type", "application/json")
      .send(raw);
  }

  const emailReceived = (overrides: Record<string, unknown> = {}) => ({
    type: "email.received",
    data: {
      email_id: `re_${Math.random().toString(36).slice(2)}`,
      created_at: "2026-08-21T09:15:00.000Z",
      from: `Jane Smith <${sender}>`,
      to: [address],
      received_for: [address],
      message_id: "<abc@example.com>",
      subject: "Leaking roof",
      ...overrides,
    },
  });

  // -------------------------------------------------------------------------
  describe("the door", () => {
    it("accepts a webhook Resend really signed", async () => {
      const response = await post(emailReceived()).expect(200);
      expect(response.body.status).toBe("converted");
    });

    /**
     * ⚠️ NO SIGNATURE, NO ENTRY — AND NOTHING WRITTEN. An unsigned request that
     * still created a lead would mean anybody who learns this URL can put words
     * in a stranger's mouth inside a customer's book.
     */
    it("refuses an unsigned request and writes nothing", async () => {
      const before = await owner.lead.count({ where: { organisationId: org.id } });
      await request(app.getHttpServer())
        .post("/integrations/resend/inbound")
        .send(emailReceived())
        .expect(401);
      expect(await owner.lead.count({ where: { organisationId: org.id } })).toBe(before);
    });

    it("refuses a signature made with somebody else's secret", async () => {
      const before = await owner.lead.count({ where: { organisationId: org.id } });
      await post(emailReceived(), {
        secret: `whsec_${Buffer.from("not-our-secret").toString("base64")}`, // gitleaks:allow — fake test fixture
      }).expect(401);
      expect(await owner.lead.count({ where: { organisationId: org.id } })).toBe(before);
    });

    /** The body is signed, so changing it after the fact must be detectable. */
    it("refuses a body altered after it was signed", async () => {
      const payload = emailReceived();
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const id = "msg_tampered";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = signForTest(TEST_RESEND_WEBHOOK_SECRET, id, timestamp, body);

      await request(app.getHttpServer())
        .post("/integrations/resend/inbound")
        .set("svix-id", id)
        .set("svix-timestamp", timestamp)
        .set("svix-signature", signature)
        .set("Content-Type", "application/json")
        .send(JSON.stringify(emailReceived({ subject: "Something else" })))
        .expect(401);
    });

    it("refuses a webhook replayed long after it was sent", async () => {
      await post(emailReceived(), {
        timestamp: (Math.floor(Date.now() / 1000) - 3600).toString(),
      }).expect(401);
    });

    /**
     * ⚠️ FAIL CLOSED WHEN THE SECRET IS MISSING. The tempting shape is "no
     * secret configured, so skip verification" — which opens the door precisely
     * on the environment where somebody forgot to set it, silently.
     */
    it("refuses everything when no signing secret is configured", async () => {
      const unconfigured = await createTestApp({
        receivedMail,
        env: { RESEND_WEBHOOK_SECRET: "" },
      });
      try {
        const raw = JSON.stringify(emailReceived());
        const body = Buffer.from(raw, "utf8");
        const timestamp = Math.floor(Date.now() / 1000).toString();
        await request(unconfigured.getHttpServer())
          .post("/integrations/resend/inbound")
          .set("svix-id", "msg_x")
          .set("svix-timestamp", timestamp)
          .set("svix-signature", signForTest(TEST_RESEND_WEBHOOK_SECRET, "msg_x", timestamp, body))
          .set("Content-Type", "application/json")
          .send(raw)
          .expect(401);
      } finally {
        await unconfigured.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("the lead", () => {
    it("creates a lead with the sender, the subject and the message", async () => {
      const payload = emailReceived();
      const response = await post(payload).expect(200);

      const lead = await owner.lead.findFirst({
        where: { organisationId: org.id, id: response.body.leadId ?? undefined },
        orderBy: { createdAt: "desc" },
        include: { evidence: true },
      });
      expect(lead).not.toBeNull();
      expect(lead!.source).toBe("email_enquiry");
      expect(lead!.contactEmail).toBe(sender);
      expect(lead!.contactName).toBe("Jane Smith");
      expect(lead!.contactPhone).toBeNull();
      expect(lead!.enquiry).toContain("my roof is leaking");
      expect(lead!.status).toBe("new");
      // Their clock, not ours: the moment it arrived, not the moment we stored it.
      expect(lead!.receivedAt.toISOString()).toBe("2026-08-21T09:15:00.000Z");
      // No person did this.
      expect(lead!.createdBy).toBeNull();
    });

    /**
     * ⚠️ THE THREE COLUMNS THAT STOOD EMPTY THROUGH 3.1A. `sender_address`,
     * `recipient_address` and `subject` shipped with migration 0026 and nothing
     * could write them, because the only way to make a lead was by hand. They
     * are what turns "somebody enquired" into a claim that can be checked
     * against a mail server — which is the entire point of evidence under PECR.
     */
    it("fills the evidence columns that only a real delivery can fill", async () => {
      const payload = emailReceived();
      await post(payload).expect(200);

      const evidence = await owner.leadEvidence.findFirst({
        where: { organisationId: org.id },
        orderBy: { createdAt: "desc" },
      });
      expect(evidence).not.toBeNull();
      expect(evidence!.channel).toBe("email_enquiry");
      expect(evidence!.senderAddress).toBe(sender);
      expect(evidence!.recipientAddress).toBe(address);
      expect(evidence!.subject).toBe("Leaking roof");
      expect(evidence!.externalId).toBe(payload.data.email_id);
      expect(evidence!.rawExcerpt).toContain("my roof is leaking");
    });

    /**
     * ⚠️ CAPTURED NOW, BEFORE ANYTHING READS THEM (ruling 32). `Auto-Submitted`,
     * `Precedence: bulk` and `List-*` are how Eva will know not to answer
     * another machine — and answering another auto-responder is a loop that
     * runs on the CUSTOMER'S domain, in their name. A header not stored at
     * arrival cannot be recovered afterwards.
     */
    it("keeps the headers the reply rules will need", async () => {
      nextMessage = {
        ...nextMessage,
        headers: {
          "message-id": "<xyz@example.com>",
          "auto-submitted": "auto-replied",
          precedence: "bulk",
          "list-unsubscribe": "<mailto:no@example.com>",
        },
      };
      await post(emailReceived()).expect(200);

      const message = await owner.inboundMessage.findFirst({
        where: { organisationId: org.id },
        orderBy: { createdAt: "desc" },
      });
      const headers = message!.headers as Record<string, string>;
      expect(headers["auto-submitted"]).toBe("auto-replied");
      expect(headers["precedence"]).toBe("bulk");
      expect(headers["list-unsubscribe"]).toBe("<mailto:no@example.com>");
    });

    it("stores the whole message, not only the excerpt on the lead", async () => {
      const long = `${"Please help. ".repeat(500)}END`;
      nextMessage = { ...nextMessage, text: long };
      await post(emailReceived()).expect(200);

      const message = await owner.inboundMessage.findFirst({
        where: { organisationId: org.id },
        orderBy: { createdAt: "desc" },
        include: { lead: { include: { evidence: true } } },
      });
      expect(message!.textBody).toBe(long);
      expect(message!.textBody!.length).toBeGreaterThan(4000);
      // The lead quotes an excerpt; the complete message stays on the delivery.
      expect(message!.lead!.enquiry!.length).toBe(4000);
    });

    it("puts the lead in the organisation that owns the address, and no other", async () => {
      const before = await owner.lead.count({ where: { organisationId: unentitledOrg.id } });
      await post(emailReceived()).expect(200);
      expect(await owner.lead.count({ where: { organisationId: unentitledOrg.id } })).toBe(before);
    });
  });

  /**
   * ⚠️ EVERY CASE HERE CAME FROM ONE REAL EMAIL, SENT FROM OUTLOOK TO
   * PRODUCTION ON 2026-08-21. The suite was green, both walls were green,
   * CodeQL was green — and the first genuine enquiry still landed with the
   * sender's NAME missing, because Resend's API summarises `from` down to a
   * bare address while the raw header carries `"Shahbaz Malik" <…>`.
   *
   * The lesson is not "parse harder". It is that a provider's convenience
   * fields and its raw headers are different data, and the raw header is the
   * one the sender actually wrote.
   */
  describe("what a real email actually looks like", () => {
    it("takes the sender's name from the raw header, not the provider's summary", async () => {
      nextMessage = {
        ...nextMessage,
        // Exactly what Resend returned: the summary has no display name...
        from: "shahbaz.malik@hotmail.co.uk",
        // ...while the header it also handed us does.
        headers: {
          ...nextMessage.headers,
          from: '"Shahbaz Malik" <shahbaz.malik@hotmail.co.uk>',
        },
      };
      const payload = emailReceived({ from: "shahbaz.malik@hotmail.co.uk" });
      await post(payload).expect(200);

      const lead = await owner.lead.findFirst({
        where: { evidence: { externalId: payload.data.email_id } },
      });
      expect(lead!.contactName, "the person's name must survive").toBe("Shahbaz Malik");
      expect(lead!.contactEmail).toBe("shahbaz.malik@hotmail.co.uk");
    });

    it("still works when only the bare address is available anywhere", async () => {
      nextMessage = {
        ...nextMessage,
        from: "nobody@example.com",
        headers: { "message-id": "<bare@example.com>" },
      };
      const payload = emailReceived();
      await post(payload).expect(200);

      const lead = await owner.lead.findFirst({
        where: { evidence: { externalId: payload.data.email_id } },
      });
      expect(lead!.contactName).toBeNull();
      expect(lead!.contactEmail).toBe("nobody@example.com");
    });

    /**
     * ⚠️ THE SAME MISTAKE, POINTING AT THE RECIPIENT, WHERE IT COSTS MORE. A
     * display name on the sender loses a name; a display name on the RECIPIENT
     * matches no stored address, so the mail is logged unroutable and the
     * enquiry is gone with nobody to tell.
     */
    it("routes correctly even if the recipient arrives with a display name", async () => {
      const payload = emailReceived({
        received_for: [`Enquiries <${address}>`],
        to: [`Enquiries <${address}>`],
      });
      const response = await post(payload).expect(200);
      expect(response.body.status).toBe("converted");

      const message = await owner.inboundMessage.findFirst({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(message!.deliveredTo).toBe(address);
    });

    /**
     * Resend runs on SES and passes its spam verdict through as a header. Not
     * used yet — ruling 32's classifier is 3.1c — but it is captured, and this
     * pins that it keeps being captured.
     */
    it("keeps the provider's own spam verdict for the classifier to use later", async () => {
      nextMessage = {
        ...nextMessage,
        headers: {
          ...nextMessage.headers,
          "x-ses-spam-verdict": "PASS",
          "received-spf": "pass (spfCheck: domain of hotmail.co.uk designates ...)",
        },
      };
      await post(emailReceived()).expect(200);

      const message = await owner.inboundMessage.findFirst({
        where: { organisationId: org.id },
        orderBy: { createdAt: "desc" },
      });
      const headers = message!.headers as Record<string, string>;
      expect(headers["x-ses-spam-verdict"]).toBe("PASS");
      expect(headers["received-spf"]).toContain("pass");
    });
  });

  // -------------------------------------------------------------------------
  describe("exactly once", () => {
    /**
     * ⚠️ THE SAME MESSAGE DELIVERED TWICE MUST NOT BECOME TWO ENQUIRIES.
     * Resend retries on any non-2xx, on timeouts, and on successes it did not
     * hear about. Without the unique index on (provider, provider_message_id),
     * a single network blip puts the same person in the book twice — and once
     * Eva is answering, emails them twice.
     */
    it("makes one lead from a message delivered twice", async () => {
      const payload = emailReceived();
      const first = await post(payload).expect(200);
      const second = await post(payload).expect(200);

      expect(first.body.status).toBe("converted");
      expect(second.body.status).toBe("duplicate");

      const messages = await owner.inboundMessage.findMany({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(messages).toHaveLength(1);
      expect(
        await owner.lead.count({ where: { evidence: { externalId: payload.data.email_id } } }),
      ).toBe(1);
    });

    /**
     * ⚠️ A RETRY AFTER A FAILURE MUST RESUME, NOT BE TURNED AWAY. If any
     * existing row counted as "already seen", the first transient fetch failure
     * would end that enquiry's life: the webhook would retry, we would answer
     * "seen it", and no lead would ever be made. This is the difference between
     * `alreadySettled` and `alreadySeen` in the intake service.
     */
    it("resumes and converts when a retry follows a failed fetch", async () => {
      const payload = emailReceived();

      fetchFails = new Error("Resend refused to return the message (HTTP 503)");
      await post(payload).expect(500);

      const afterFailure = await owner.inboundMessage.findFirst({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(afterFailure!.status).toBe("failed");
      expect(afterFailure!.failureReason).toContain("503");
      expect(afterFailure!.leadId).toBeNull();

      fetchFails = null;
      const retry = await post(payload).expect(200);
      expect(retry.body.status).toBe("converted");

      const afterRetry = await owner.inboundMessage.findFirst({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(afterRetry!.status).toBe("converted");
      expect(afterRetry!.leadId).not.toBeNull();
      expect(afterRetry!.failureReason).toBeNull();
      // Still one delivery, and one lead.
      expect(
        await owner.inboundMessage.count({ where: { providerMessageId: payload.data.email_id } }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("what is kept when it goes wrong", () => {
    /**
     * ⚠️ THE ONLY COPY. The enquiry was sent to the customer's mailbox and
     * forwarded here; there is nowhere to go back and re-read it from. So the
     * delivery is written down BEFORE the fetch that can fail.
     */
    it("keeps the delivery when the message itself cannot be fetched", async () => {
      const payload = emailReceived();
      fetchFails = new Error("Resend refused to return the message (HTTP 500)");

      await post(payload).expect(500);

      const message = await owner.inboundMessage.findFirst({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(message, "the delivery must survive a failed fetch").not.toBeNull();
      expect(message!.status).toBe("failed");
      expect(message!.deliveredTo).toBe(address);
      expect(message!.subject).toBe("Leaking roof");
    });

    /**
     * A `From` we cannot read an address out of cannot become a lead — there
     * would be no way to answer it, and `leads_contact_check` refuses it in the
     * database. It is still kept, and still visible.
     */
    it("keeps the delivery when the sender cannot be read, and makes no lead", async () => {
      const payload = emailReceived();
      nextMessage = { ...nextMessage, from: "Nobody At All" };
      const before = await owner.lead.count({ where: { organisationId: org.id } });

      await post(payload).expect(500);

      const message = await owner.inboundMessage.findFirst({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(message!.status).toBe("failed");
      expect(message!.failureReason).toContain("Nobody At All");
      expect(await owner.lead.count({ where: { organisationId: org.id } })).toBe(before);
    });

    /**
     * ⚠️ 200, NOT 500 — MAIL TO AN ADDRESS NOBODY WAS ISSUED IS SETTLED, NOT
     * FAILED. A 5xx tells Resend to keep retrying a message that will never
     * route, forever.
     */
    it("answers 200 and stores nothing for an address nobody was issued", async () => {
      const before = await owner.inboundMessage.count();
      const response = await post(
        emailReceived({ received_for: [`nobody-aaaaaa@test-inbound.eva.local`], to: [] }),
      ).expect(200);
      expect(response.body.status).toBe("unroutable");
      expect(await owner.inboundMessage.count()).toBe(before);
    });

    it("answers 200 and ignores an event type it does not act on", async () => {
      const before = await owner.inboundMessage.count();
      const response = await post({ type: "email.delivered", data: { email_id: "x" } }).expect(200);
      expect(response.body.status).toBe("not-applicable");
      expect(await owner.inboundMessage.count()).toBe(before);
    });

    /**
     * ⚠️ THE ADDRESS OUTLIVES THE ENTITLEMENT. A customer can stop paying for
     * Lead Follow-up while the address is still on their website. The
     * mail is theirs and is kept — but no lead is made for a product nobody
     * holds, and the fetch is never even attempted.
     */
    it("keeps the mail but makes no lead for an organisation that no longer holds the product", async () => {
      const payload = emailReceived({ received_for: [unentitledAddress], to: [unentitledAddress] });
      const response = await post(payload).expect(200);
      expect(response.body.status).toBe("ignored");

      const message = await owner.inboundMessage.findFirst({
        where: { providerMessageId: payload.data.email_id },
      });
      expect(message!.status).toBe("ignored");
      expect(message!.failureReason).toContain("lead_follow_up");
      expect(message!.leadId).toBeNull();
      expect(await owner.lead.count({ where: { organisationId: unentitledOrg.id } })).toBe(0);
      expect(fetched, "an unentitled delivery must not cost a fetch").toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  /**
   * 🚨 RULING 76 (slice 3.3b): A MESSAGE ON A THREAD THAT IS ALREADY WORKING A
   * LIVE LEAD IS A MESSAGE ON THAT LEAD, NOT A NEW ENQUIRY. Until this slice
   * every inbound email was a lead, so "any update?" the next morning put the
   * same person in the book twice and greeted them twice. Written before the
   * change, as the handoff asked, so the old behaviour was seen to go red.
   */
  describe("a second message on an open thread (ruling 76)", () => {
    const leadsFrom = (email: string) =>
      owner.lead.findMany({
        where: { organisationId: org.id, contactEmail: email, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

    it("pins every new enquiry to its person, its stage and the thread it opened", async () => {
      const payload = emailReceived();
      await post(payload).expect(200);
      const [lead] = await leadsFrom(sender);

      const newStage = await owner.pipelineStage.findFirstOrThrow({
        where: { organisationId: org.id, systemKey: "new" },
      });
      expect(lead!.pipelineStageId).toBe(newStage.id);
      expect(lead!.personId).not.toBeNull();
      expect(lead!.originConversationId).not.toBeNull();

      const person = await owner.person.findUniqueOrThrow({
        where: { id: lead!.personId! },
        include: { identities: true },
      });
      expect(person.displayName).toBe("Jane Smith");
      expect(person.primaryEmail).toBe(sender);
      // A message arrived from the address: that is proof of control.
      expect(person.identities.map((i) => [i.kind, i.value, i.verification])).toEqual([
        ["email", sender, "inbound"],
      ]);

      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: lead!.originConversationId! },
      });
      expect(thread).toMatchObject({
        channel: "email",
        channelConnectionId: null,
        status: "open",
        leadId: lead!.id,
        personId: person.id,
        // What a reply must quote to thread in their mail client.
        providerThreadId: "<abc@example.com>",
        // Email has no window.
        replyWindowExpiresAt: null,
      });

      const raw = await owner.inboundMessage.findFirstOrThrow({
        where: { providerMessageId: payload.data.email_id },
      });
      const canonical = await owner.message.findFirstOrThrow({
        where: { sourceTable: "inbound_messages", sourceId: raw.id },
      });
      expect(canonical).toMatchObject({
        conversationId: thread.id,
        personId: person.id,
        channel: "email",
        direction: "inbound",
        senderKind: "person",
        contentType: "text",
        subject: "Leaking roof",
        providerMessageId: payload.data.email_id,
      });
      expect(canonical.bodyText).toContain("my roof is leaking");
      expect(canonical.occurredAt.toISOString()).toBe("2026-08-21T09:15:00.000Z");
    });

    it("files a follow-up from the same person on the enquiry already being worked, not as a second one", async () => {
      const opened = await post(emailReceived()).expect(200);
      expect(opened.body.status).toBe("converted");

      nextMessage = {
        ...nextMessage,
        subject: "Re: Leaking roof",
        text: "Any update on this?",
        headers: { "message-id": "<def@example.com>" },
      };
      const again = await post(
        emailReceived({ subject: "Re: Leaking roof", message_id: "<def@example.com>" }),
      ).expect(200);
      expect(again.body.status).toBe("attached");

      const leads = await leadsFrom(sender);
      expect(leads, "a follow-up must not be a second enquiry").toHaveLength(1);
      const lead = leads[0]!;

      const rows = await owner.inboundMessage.findMany({
        where: { organisationId: org.id, fromAddress: { contains: sender } },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === "converted" && row.leadId === lead.id)).toBe(true);
      expect(
        await owner.message.count({ where: { conversationId: lead.originConversationId! } }),
      ).toBe(2);
      expect(await owner.conversation.count({ where: { personId: lead.personId! } })).toBe(1);
      // The thread keeps the FIRST message's id: that is what a reply threads on.
      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: lead.originConversationId! },
      });
      expect(thread.providerThreadId).toBe("<abc@example.com>");
    });

    it("opens a new enquiry once the earlier thread is resolved", async () => {
      await post(emailReceived()).expect(200);
      const [lead] = await leadsFrom(sender);
      await owner.conversation.update({
        where: { id: lead!.originConversationId! },
        data: { status: "resolved", resolvedAt: new Date() },
      });

      const response = await post(emailReceived({ message_id: "<later@example.com>" })).expect(200);
      expect(response.body.status).toBe("converted");

      const leads = await leadsFrom(sender);
      expect(leads).toHaveLength(2);
      // The same person, a new thread; the old thread still names the old enquiry.
      expect(leads[1]!.personId).toBe(lead!.personId);
      expect(leads[1]!.originConversationId).not.toBe(lead!.originConversationId);
      const old = await owner.conversation.findUniqueOrThrow({
        where: { id: lead!.originConversationId! },
      });
      expect(old.leadId).toBe(lead!.id);
    });

    it("opens a new enquiry on the same thread when the earlier one was retired", async () => {
      await post(emailReceived()).expect(200);
      const [lead] = await leadsFrom(sender);
      await owner.lead.update({ where: { id: lead!.id }, data: { deletedAt: new Date() } });

      const response = await post(emailReceived()).expect(200);
      expect(response.body.status).toBe("converted");

      const live = await leadsFrom(sender);
      expect(live).toHaveLength(1);
      expect(live[0]!.id).not.toBe(lead!.id);
      // Same thread, repointed at the new enquiry (ruling 67).
      expect(live[0]!.originConversationId).toBe(lead!.originConversationId);
      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: lead!.originConversationId! },
      });
      expect(thread.leadId).toBe(live[0]!.id);
    });
  });
});
