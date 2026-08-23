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
  ForwardingConfirmationError,
  type ForwardingConfirmer,
} from "../src/capabilities/mailbox/inbound/forwarding-confirmer.js";
import { ARMED_WINDOW_MINUTES } from "../src/capabilities/mailbox/inbound/forwarding-confirmations.service.js";
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
 * The guided forwarding setup (Slice 3.1b, step 4).
 *
 * A Gmail customer cannot hand us their inbox — reading it is a RESTRICTED
 * scope and an audit every twelve months (ruling 25) — so they forward it, and
 * Google asks OUR permission by email because we own the address it is being
 * forwarded to. Eva answers that email for them, so nobody hunts for a code.
 *
 * ⚠️ THE WHOLE FILE IS ABOUT ONE LINE THAT COULD HAVE BEEN WRITTEN LAZILY.
 * "Confirm it for them automatically" is one `if` away from "confirm anything
 * that asks" — and that second thing hands anybody who guesses an enquiry
 * address (ruling 33 sized the random tail against exactly this) a silent feed
 * into a stranger's lead book, and from 3.1c a way to make Eva write to people
 * over that customer's own signature. Google's confirmation step is the only
 * lock on that door and we are holding the key.
 *
 * So: armed means Eva answers, unarmed means the customer does, and both are
 * proved here from both directions.
 */
describe("Guided forwarding: who may forward mail into a customer's book", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let otherOrg: FixtureOrg;
  let address: string;
  let otherAddress: string;
  const tokens = new Map<string, string>();
  let otherToken: string;

  let nextMessage: ReceivedMessage;

  /** Every URL the confirmer was asked to fetch, and what it should answer. */
  const confirmed: string[] = [];
  let confirmFails: string | null = null;

  const confirmer: ForwardingConfirmer = {
    async confirm(url: string): Promise<void> {
      confirmed.push(url);
      if (confirmFails) throw new ForwardingConfirmationError(confirmFails);
    },
  };

  const receivedMail: ReceivedMail = {
    async fetch(): Promise<ReceivedMessage> {
      return nextMessage;
    },
  };

  /** The confirm and cancel links, as Google really sends them (2026-08-22). */
  const CONFIRM = "https://mail-settings.google.com/mail/vf-%5Bexample-token%5D-tail";
  const CANCEL = "https://mail-settings.google.com/mail/uf-%5Bexample-token%5D-tail";

  /**
   * Google's real message, trimmed. Verbatim wording, because the parser is
   * only worth anything against what Google actually sends: no confirmation
   * code anywhere, an en dash in the subject, and the cancel link nine lines
   * below the confirm link.
   */
  function googleConfirmation(source = "customer@gmail.com"): ReceivedMessage {
    return {
      from: "forwarding-noreply@google.com",
      subject: `(Gmail Forwarding confirmation – Receive mail from ${source}`,
      text: [
        `${source} has requested to automatically forward`,
        "mail to your email",
        `address ${address}.`,
        "",
        "please click the link below to confirm the request:",
        "",
        CONFIRM,
        "",
        "click this link to cancel this verification:",
        CANCEL,
      ].join("\n"),
      html: null,
      headers: { from: "forwarding-noreply@google.com", "message-id": "<goog@mail.gmail.com>" },
    };
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp({ receivedMail, forwardingConfirmer: confirmer });

    org = await createOrgWithMembers(
      owner,
      "forwarding",
      ["owner", "read_only"],
      "Halloway Roofing",
      [{ moduleKey: "lead_follow_up_email" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
    address = await issueAddress(org, tokens.get("owner")!);

    otherOrg = await createOrgWithMembers(owner, "forwarding-other", ["owner"], "Other Co", [
      { moduleKey: "lead_follow_up_email" },
    ]);
    otherToken = await signToken({
      sub: otherOrg.members[0]!.authUserId,
      email: otherOrg.members[0]!.email,
    });
    otherAddress = await issueAddress(otherOrg, otherToken);
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(async () => {
    confirmed.length = 0;
    confirmFails = null;
    nextMessage = googleConfirmation();
    // Every test starts with the window shut; the ones that need it open say so.
    // Scoped to this spec's own organisations: spec files share `eva_test`, and
    // a blanket updateMany would reach into whatever else is running.
    const mine = { organisationId: { in: [org.id, otherOrg.id] } };
    await owner.inboundAddress.updateMany({
      where: mine,
      data: { forwardingArmedAt: null, forwardingArmedBy: null },
    });
    await owner.inboundForwardingRequest.deleteMany({ where: mine });
  });

  async function issueAddress(fixture: FixtureOrg, token: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/organisations/${fixture.id}/inbound-address`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return response.body.address as string;
  }

  /** A webhook exactly as Resend sends one, signed the way Resend signs it. */
  function deliver(to: string, messageId = `eml_${Math.random().toString(36).slice(2)}`) {
    const payload = {
      type: "email.received",
      data: {
        email_id: messageId,
        created_at: "2026-08-22T17:59:00.000Z",
        from: "forwarding-noreply@google.com",
        to: [to],
        received_for: [to],
        message_id: "<goog@mail.gmail.com>",
        subject: "Gmail Forwarding confirmation",
      },
    };
    // Sent as a STRING: superagent re-serialises a Buffer under a JSON
    // content type, and the HMAC could then never match.
    const raw = JSON.stringify(payload);
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signForTest(
      TEST_RESEND_WEBHOOK_SECRET,
      id,
      timestamp,
      Buffer.from(raw, "utf8"),
    );
    return request(app.getHttpServer())
      .post("/integrations/resend/inbound")
      .set("Content-Type", "application/json")
      .set("svix-id", id)
      .set("svix-timestamp", timestamp)
      .set("svix-signature", signature)
      .send(raw);
  }

  const arm = (token: string, organisationId: string) =>
    request(app.getHttpServer())
      .post(`/organisations/${organisationId}/forwarding/arm`)
      .set("Authorization", `Bearer ${token}`);

  const listRequests = (token: string, organisationId: string) =>
    request(app.getHttpServer())
      .get(`/organisations/${organisationId}/forwarding/requests`)
      .set("Authorization", `Bearer ${token}`);

  const settle = (token: string, organisationId: string, requestId: string, decision: unknown) =>
    request(app.getHttpServer())
      .post(`/organisations/${organisationId}/forwarding/requests/${requestId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision });

  // -------------------------------------------------------------------------
  describe("Google's paperwork is not an enquiry", () => {
    /**
     * ⚠️ THE DEFECT THIS SLICE EXISTS TO REMOVE. Before this branch, Google's
     * confirmation email went through the ordinary intake path and became a
     * lead — a prospective customer called "Gmail Team", in the book, with a
     * contact address of `forwarding-noreply@google.com`. From 3.1c that lead
     * gets a reply about somebody's roof, sent to Google's no-reply mailbox, in
     * the customer's name.
     */
    it("never becomes a lead", async () => {
      const response = await deliver(address).expect(200);
      expect(response.body.status).toBe("ignored");

      const leads = await owner.lead.findMany({ where: { organisationId: org.id } });
      expect(leads).toHaveLength(0);
    });

    /**
     * ⚠️ KEPT, NOT DROPPED. The stored message is the only place a reworded
     * Google email would exist, and it is the evidence of how a customer's
     * front door came to be pointed at their Gmail.
     */
    it("is still stored, with its body and a reason", async () => {
      await deliver(address).expect(200);
      const message = await owner.inboundMessage.findFirst({
        where: { organisationId: org.id },
      });
      expect(message?.status).toBe("ignored");
      expect(message?.failureReason).toMatch(/forwarding confirmation/i);
      expect(message?.textBody).toContain("has requested to automatically forward");
    });

    it("records who asked, and the link it will answer with", async () => {
      await deliver(address).expect(200);
      const [row] = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: org.id },
      });
      expect(row?.sourceAddress).toBe("customer@gmail.com");
      expect(row?.confirmationUrl).toBe(CONFIRM);
      /** Google stopped sending a code; the row must not invent one. */
      expect(row?.confirmationCode).toBeNull();
    });

    /**
     * ⚠️ WEBHOOKS RETRY AND GMAIL RESENDS. Asking the customer the same
     * question twice — or re-confirming something they declined — is worse
     * than doing nothing.
     */
    it("asks the customer at most once per message", async () => {
      /**
       * ⚠️ UNIQUE PER RUN, AND A HARD-CODED ID HERE COST A RED SUITE.
       * `eva_test` is not recreated between local runs and
       * `inbound_messages.provider_message_id` is unique across every
       * organisation — so a fixed id collides with the row the PREVIOUS run
       * left behind, and the failure arrives as a 500 from the webhook rather
       * than anything resembling the thing under test.
       */
      const messageId = `eml_repeat_${Date.now()}`;
      await deliver(address, messageId).expect(200);
      await deliver(address, messageId).expect(200);

      const rows = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: org.id },
      });
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("the armed window", () => {
    it("answers Google itself when the customer is setting it up", async () => {
      await arm(tokens.get("owner")!, org.id).expect(200);
      await deliver(address).expect(200);

      expect(confirmed).toEqual([CONFIRM]);
      const [row] = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: org.id },
      });
      expect(row?.status).toBe("confirmed");
      /** No user on the row means Eva did it — the screen says so. */
      expect(row?.settledBy).toBeNull();
    });

    /**
     * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE. An unarmed request is somebody
     * we were not expecting asking to read a customer's mail. Confirming it
     * would be silent and irreversible from the customer's point of view.
     */
    it("will not answer a request nobody asked for, and does not touch Google", async () => {
      await deliver(address).expect(200);

      expect(confirmed).toEqual([]);
      const [row] = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: org.id },
      });
      expect(row?.status).toBe("pending");
      expect(row?.settledAt).toBeNull();
    });

    /**
     * ⚠️ A WINDOW, NOT A FLAG. A permanent "this customer allows forwarding"
     * switch would still be open a year later when somebody guesses the
     * address. This is the test that stops the window quietly becoming one.
     */
    it("closes on its own, so a request the next day is still asked about", async () => {
      await arm(tokens.get("owner")!, org.id).expect(200);
      await owner.inboundAddress.updateMany({
        where: { organisationId: org.id },
        data: {
          forwardingArmedAt: new Date(Date.now() - (ARMED_WINDOW_MINUTES + 1) * 60_000),
        },
      });

      await deliver(address).expect(200);

      expect(confirmed).toEqual([]);
      const [row] = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: org.id },
      });
      expect(row?.status).toBe("pending");
    });

    /**
     * ⚠️ ARMING IS NOT A PAGE VIEW. It decides whose mail Eva accepts without
     * asking, so the role that may only read the book must not be able to.
     */
    it("cannot be opened by a role that may only read", async () => {
      await arm(tokens.get("read_only")!, org.id).expect(403);
    });

    /** One organisation arming its own door must not open anybody else's. */
    it("is opened for one organisation only", async () => {
      await arm(tokens.get("owner")!, org.id).expect(200);
      await deliver(otherAddress).expect(200);

      expect(confirmed).toEqual([]);
      const [row] = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: otherOrg.id },
      });
      expect(row?.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  describe("when the customer answers it themselves", () => {
    async function pendingRequest(): Promise<string> {
      await deliver(address).expect(200);
      const response = await listRequests(tokens.get("owner")!, org.id).expect(200);
      return (response.body as { id: string }[])[0]!.id;
    }

    it("confirms on their say-so, and records that a person did it", async () => {
      const id = await pendingRequest();
      const response = await settle(tokens.get("owner")!, org.id, id, "confirm").expect(200);

      expect(response.body.status).toBe("confirmed");
      expect(response.body.confirmedAutomatically).toBe(false);
      expect(confirmed).toEqual([CONFIRM]);
    });

    /**
     * ⚠️ DECLINING TELLS GOOGLE NOTHING, AND MUST NOT PRETEND TO. Following
     * the cancel link would be us cancelling on the requester's behalf, which
     * nobody asked us to do. Declining means WE will not confirm — and without
     * our confirmation Google never starts forwarding, which is the outcome the
     * customer wanted.
     */
    it("declines without touching Google at all", async () => {
      const id = await pendingRequest();
      const response = await settle(tokens.get("owner")!, org.id, id, "decline").expect(200);

      expect(response.body.status).toBe("declined");
      expect(confirmed).toEqual([]);
    });

    it("will not un-decline a request that was refused", async () => {
      const id = await pendingRequest();
      await settle(tokens.get("owner")!, org.id, id, "decline").expect(200);
      const response = await settle(tokens.get("owner")!, org.id, id, "confirm").expect(200);

      expect(response.body.status).toBe("declined");
      expect(confirmed).toEqual([]);
    });

    /**
     * ⚠️ REFUSED RATHER THAN DEFAULTED. Reading an unrecognised body as
     * "decline" looks like the safe direction — it grants nothing — but
     * `declined` is TERMINAL, so a misspelled field would permanently refuse a
     * request the customer was trying to approve.
     */
    it("refuses a decision it does not recognise instead of guessing", async () => {
      const id = await pendingRequest();
      await settle(tokens.get("owner")!, org.id, id, "yes-please").expect(400);

      const [row] = await owner.inboundForwardingRequest.findMany({
        where: { organisationId: org.id },
      });
      expect(row?.status).toBe("pending");
    });

    it("cannot be answered by a role that may only read", async () => {
      const id = await pendingRequest();
      await settle(tokens.get("read_only")!, org.id, id, "confirm").expect(403);
    });

    /** Another tenant's request is not theirs to see or to answer. */
    it("cannot be answered from another organisation", async () => {
      const id = await pendingRequest();
      await settle(otherToken, otherOrg.id, id, "confirm").expect(404);

      const listed = await listRequests(otherToken, otherOrg.id).expect(200);
      expect(listed.body).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("when Google will not play", () => {
    /**
     * ⚠️ A FAILED ATTEMPT LEAVES THE REQUEST OPEN. The link is still valid and
     * the customer can still use it; marking the row failed would take that
     * away from them for what may have been a five-second network blip. The
     * screen shows the link — which is the only fallback there is, because
     * Google no longer sends a code.
     */
    it("leaves the request open, with the link still offered", async () => {
      confirmFails = "Google did not answer in time";
      await arm(tokens.get("owner")!, org.id).expect(200);
      await deliver(address).expect(200);

      const response = await listRequests(tokens.get("owner")!, org.id).expect(200);
      const [row] = response.body as {
        status: string;
        failureReason: string;
        confirmUrl: string;
      }[];
      expect(row?.status).toBe("pending");
      expect(row?.failureReason).toBe("Google did not answer in time");
      expect(row?.confirmUrl).toBe(CONFIRM);
    });

    it("does not let a failed confirmation lose the webhook", async () => {
      confirmFails = "Google could not be reached";
      await arm(tokens.get("owner")!, org.id).expect(200);
      // 200, not 5xx: the message was handled and Resend must not retry it.
      await deliver(address).expect(200);
    });
  });
});
