import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * Correcting a do-not-contact recorded in error, over HTTP (2026-08-21).
 *
 * ⚠️ THE PERMISSION SPLIT IS THE SAFEGUARD, AND IT IS WHAT THIS FILE MOSTLY
 * TESTS. Recording a do-not-contact is `leads:write`, which sales and reception
 * hold. Saying one was a mistake is `suppression:manage`, which they do not.
 * If the person who mis-clicked could also erase it, the compliance record
 * would only be as good as their embarrassment — so "undoing is a different act
 * from doing" has to be enforced, not just intended.
 *
 * ⚠️ AND THE ENTRY IS NEVER REMOVED. Every test here that corrects something
 * also checks the original is still in the log. A correction that deleted would
 * pass every behavioural assertion in this file and destroy the thing the table
 * exists for.
 */
describe("Do-not-contact: the correction path", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(
      owner,
      "suppression",
      ["owner", "administrator", "sales", "reception", "finance", "read_only"],
      undefined,
      [{ moduleKey: "email_credit_controller" }, { moduleKey: "lead_follow_up" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /** Puts a value on the list the way the product does — through a lead. */
  const suppressViaLead = async (contactEmail: string): Promise<string> => {
    const lead = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/leads`)
      .set("Authorization", `Bearer ${tokens.get("sales")!}`)
      .send({
        source: "email_enquiry",
        contactEmail,
        receivedAt: "2026-08-17T09:30:00.000Z",
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/leads/${lead.body.id}/do-not-contact`)
      .set("Authorization", `Bearer ${tokens.get("sales")!}`)
      .expect(201);

    return lead.body.id as string;
  };

  const correct = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/organisations/${org.id}/suppression/corrections`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  const listAs = (token: string) =>
    request(app.getHttpServer())
      .get(`/organisations/${org.id}/suppression`)
      .set("Authorization", `Bearer ${token}`);

  it("shows the owner who is on the list, and why", async () => {
    await suppressViaLead("on-the-list@example.com");

    const response = await listAs(tokens.get("owner")!).expect(200);
    const entry = response.body.find(
      (row: { value: string }) => row.value === "on-the-list@example.com",
    );
    expect(entry, "a suppressed address is missing from the list").toBeDefined();
    expect(entry.channel).toBe("email");
    // Who put them there, resolved to a name rather than a uuid.
    expect(entry.recordedBy).toBeTruthy();
  });

  it("corrects an entry, and leaves the original in the log", async () => {
    await suppressViaLead("wrong-person@example.com");

    await correct(tokens.get("owner")!, {
      channel: "email",
      value: "wrong-person@example.com",
      reason: "Pressed it on the wrong enquiry entirely",
    }).expect(201);

    const listed = await listAs(tokens.get("owner")!).expect(200);
    expect(listed.body.map((row: { value: string }) => row.value)).not.toContain(
      "wrong-person@example.com",
    );

    // ⚠️ SUPERSEDED, NOT DELETED. Both events survive, in order.
    const events = await owner.consentEvent.findMany({
      where: { organisationId: org.id, value: "wrong-person@example.com" },
      orderBy: { createdAt: "asc" },
      select: { state: true },
    });
    expect(events.map((event) => event.state)).toEqual(["opted_out", "corrected"]);
  });

  it("writes an audit entry naming who undid it and why", async () => {
    await suppressViaLead("audit-me@example.com");
    await correct(tokens.get("owner")!, {
      channel: "email",
      value: "audit-me@example.com",
      reason: "Logged against the wrong client record",
    }).expect(201);

    const entry = await owner.auditLog.findFirst({
      where: {
        organisationId: org.id,
        action: "suppression.corrected",
        entityId: "audit-me@example.com",
      },
    });
    expect(entry, "correcting a do-not-contact left no audit trail").not.toBeNull();
    // ⚠️ THE REASON IS THE POINT. "Somebody undid a do-not-contact" without why
    // is a line that raises a question and answers none.
    expect(JSON.stringify(entry!.metadata)).toContain("Logged against the wrong client record");
    expect(entry!.actorUserId).toBeTruthy();
  });

  describe("who may undo one", () => {
    /**
     * ⚠️ THE ROLE THAT CAN CREATE ONE CANNOT UNDO IT, AND THAT IS THE DESIGN.
     * Sales and reception hold `leads:write` — they pressed the button — but
     * `suppression:manage` is owner and administrator only.
     */
    it.each(["sales", "reception"])(
      "refuses %s, who can record one but not undo one",
      async (role) => {
        await suppressViaLead(`${role}-cannot-undo@example.com`);
        await correct(tokens.get(role)!, {
          channel: "email",
          value: `${role}-cannot-undo@example.com`,
          reason: "I should not be allowed to do this",
        }).expect(403);

        // Still suppressed — the refusal was real, not cosmetic.
        const events = await owner.consentEvent.findMany({
          where: { organisationId: org.id, value: `${role}-cannot-undo@example.com` },
          select: { state: true },
        });
        expect(events.map((event) => event.state)).toEqual(["opted_out"]);
      },
    );

    it.each(["finance", "read_only"])("refuses %s entirely", async (role) => {
      await listAs(tokens.get(role)!).expect(403);
    });

    it("lets an administrator undo one", async () => {
      await suppressViaLead("admin-can-undo@example.com");
      await correct(tokens.get("administrator")!, {
        channel: "email",
        value: "admin-can-undo@example.com",
        reason: "Recorded in error during a demo",
      }).expect(201);
    });
  });

  describe("what it refuses", () => {
    it("refuses a correction with no reason", async () => {
      await suppressViaLead("needs-a-reason@example.com");
      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "needs-a-reason@example.com",
      }).expect(400);
    });

    /**
     * ⚠️ "mistake" IS NOT AN ANSWER. This sentence is what somebody reads in a
     * year when asking why a do-not-contact was undone, so the minimum is high
     * enough to force an actual explanation.
     */
    it("refuses a one-word reason", async () => {
      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "needs-a-reason@example.com",
        reason: "mistake",
      }).expect(400);
    });

    it("refuses a channel that is not one of ours", async () => {
      await correct(tokens.get("owner")!, {
        // `phone` is the plausible wrong word; the vocabulary is `call`.
        channel: "phone",
        value: "needs-a-reason@example.com",
        reason: "Trying the wrong channel name",
      }).expect(400);
    });

    /**
     * ⚠️ A 404 IS "SOMEBODY GOT THERE FIRST", NOT A FAULT. Two administrators
     * on the same row, or one double-submitted form, must not stack two
     * corrections — and the second one must be told rather than shown a
     * success that did nothing.
     */
    it("refuses to correct something already corrected", async () => {
      await suppressViaLead("already-done@example.com");
      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "already-done@example.com",
        reason: "The first and only correction",
      }).expect(201);
      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "already-done@example.com",
        reason: "A second bite at the same entry",
      }).expect(404);
    });

    it("refuses to correct a value nobody ever suppressed", async () => {
      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "a-total-stranger@example.com",
        reason: "There is nothing here to correct",
      }).expect(404);
    });
  });

  /**
   * ⚠️ THE FIRST CORRECTION EVER MADE ON PRODUCTION LEFT A LIE ON THE SCREEN
   * (2026-08-21). The founder pressed do-not-contact on their own enquiry, both
   * channels went on the list, both were corrected — and the enquiry book still
   * showed a red "Do not contact" pill on somebody Eva was by then perfectly
   * willing to write to. Two records of one fact: `consent_events` is the
   * gate Eva obeys, `leads.status` is only a label, and the label did not
   * follow. Found by walking, not by any of the 821 tests.
   */
  describe("the enquiry the entry came from", () => {
    /** Puts a lead on the list with BOTH channels, the way the product does. */
    const suppressLeadWithBoth = async (email: string, phone: string): Promise<string> => {
      const lead = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/leads`)
        .set("Authorization", `Bearer ${tokens.get("sales")!}`)
        .send({
          source: "email_enquiry",
          contactEmail: email,
          contactPhone: phone,
          receivedAt: "2026-08-17T09:30:00.000Z",
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/leads/${lead.body.id}/do-not-contact`)
        .set("Authorization", `Bearer ${tokens.get("sales")!}`)
        .expect(201);

      return lead.body.id as string;
    };

    const statusOf = async (leadId: string): Promise<string> => {
      const detail = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/leads/${leadId}`)
        .set("Authorization", `Bearer ${tokens.get("owner")!}`)
        .expect(200);
      return detail.body.status as string;
    };

    it("stops saying do-not-contact once nothing about them is suppressed", async () => {
      const leadId = await suppressLeadWithBoth("both-channels@example.com", "07700 900321");
      expect(await statusOf(leadId)).toBe("do_not_contact");

      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "both-channels@example.com",
        reason: "Pressed on the wrong enquiry entirely",
      }).expect(201);
      await correct(tokens.get("owner")!, {
        channel: "call",
        value: "07700 900321",
        reason: "Pressed on the wrong enquiry entirely",
      }).expect(201);

      expect(
        await statusOf(leadId),
        "the enquiry still reads do-not-contact after everything was corrected",
      ).toBe("new");
    });

    /**
     * ⚠️ AND IT MUST NOT COME BACK EARLY. `doNotContact` suppresses every
     * channel it holds, so correcting the address alone leaves the person still
     * unreachable by phone. An enquiry flipped back to `new` at that point
     * would promise Eva will contact them while she still refuses to — the same
     * defect as before, pointing the other way.
     */
    it("keeps saying do-not-contact while any channel is still suppressed", async () => {
      const leadId = await suppressLeadWithBoth("half-corrected@example.com", "07700 900654");

      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "half-corrected@example.com",
        reason: "Only the address was recorded in error",
      }).expect(201);

      expect(
        await statusOf(leadId),
        "the enquiry came back while their phone number was still suppressed",
      ).toBe("do_not_contact");
    });

    it("names the enquiries it put back, in the audit trail", async () => {
      const leadId = await suppressLeadWithBoth("audited-revert@example.com", "07700 900987");
      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "audited-revert@example.com",
        reason: "Recorded against the wrong enquiry",
      }).expect(201);
      await correct(tokens.get("owner")!, {
        channel: "call",
        value: "07700 900987",
        reason: "Recorded against the wrong enquiry",
      }).expect(201);

      const entry = await owner.auditLog.findFirst({
        where: {
          organisationId: org.id,
          action: "lead.do_not_contact_reverted",
          entityId: leadId,
        },
      });
      expect(entry, "an enquiry changed state with nothing in the audit trail").not.toBeNull();
    });

    /** Somebody else's enquiry must not be dragged back by an unrelated fix. */
    it("leaves other people's enquiries alone", async () => {
      const mine = await suppressLeadWithBoth("mine@example.com", "07700 900111");
      const theirs = await suppressLeadWithBoth("theirs@example.com", "07700 900222");

      await correct(tokens.get("owner")!, {
        channel: "email",
        value: "mine@example.com",
        reason: "Only this one was a mistake",
      }).expect(201);
      await correct(tokens.get("owner")!, {
        channel: "call",
        value: "07700 900111",
        reason: "Only this one was a mistake",
      }).expect(201);

      expect(await statusOf(mine)).toBe("new");
      expect(await statusOf(theirs)).toBe("do_not_contact");
    });
  });

  /**
   * ⚠️ THE CORRECTION HAS TO REACH THE PRODUCT THAT WAS BLOCKED, OR IT IS A
   * SCREEN THAT LIES. Suppression is cross-product: an entry recorded on an
   * enquiry stops invoice chasers to the same address. If undoing it did not
   * unblock chasing, the do-not-contact screen would say the person is
   * contactable while the invoice book still refused to chase them.
   */
  it("unblocks invoice chasing for the same address", async () => {
    const email = "billing-contact@example.com";
    await suppressViaLead(email);

    const customer = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("owner")!}`)
      .send({ name: "Suppressed Client Ltd", email })
      .expect(201);

    const contact = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customer.body.id}/contacts`)
      .set("Authorization", `Bearer ${tokens.get("owner")!}`)
      .send({ name: "Their Bookkeeper", email })
      .expect(201);

    const invoice = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customer.body.id}/invoices`)
      .set("Authorization", `Bearer ${tokens.get("owner")!}`)
      .send({
        invoiceNumber: `SUP-${Date.now()}`,
        amountMinorUnits: 125000,
        currency: "GBP",
        dueDate: "2026-09-30",
        contactId: contact.body.id,
        status: "active",
      })
      .expect(201);

    const blockedBefore = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${customer.body.id}/invoices/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("owner")!}`)
      .expect(200);
    expect(blockedBefore.body.chaseBlockedReason).toBe("suppressed");

    await correct(tokens.get("owner")!, {
      channel: "email",
      value: email,
      reason: "This was the client, not the enquirer — recorded in error",
    }).expect(201);

    const blockedAfter = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${customer.body.id}/invoices/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("owner")!}`)
      .expect(200);
    expect(
      blockedAfter.body.chaseBlockedReason,
      "the invoice book still calls them suppressed after the correction",
    ).not.toBe("suppressed");
  });
});
