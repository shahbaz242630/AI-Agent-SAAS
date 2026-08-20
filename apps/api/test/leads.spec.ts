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
  type FixtureUser,
} from "./support.js";

/**
 * The lead record (Slice 3.1a) — the foundation of Lead Follow-up by Email.
 *
 * ⚠️ THE COMPLIANCE RULES ARE THE POINT OF THIS FILE, not the CRUD. Lead
 * follow-up is marketing-adjacent under PECR, and BRD 4.3 turns that into three
 * hard requirements: every lead carries evidence that the person contacted us
 * first, that evidence is immutable, and a do-not-contact request is actioned
 * "immediately and permanently… across all channels". Each has a test here that
 * fails if the rule is ever quietly relaxed.
 */
describe("Leads: the record, the evidence and the refusal", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  /** An organisation that has NOT bought lead follow-up by email. */
  let unentitledOrg: FixtureOrg;
  const tokens = new Map<string, string>();
  const membersByRole = new Map<string, FixtureUser>();
  let unentitledToken: string;

  const receivedAt = "2026-08-17T09:30:00.000Z";

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(
      owner,
      "leads",
      ["owner", "sales", "reception", "finance", "read_only"],
      undefined,
      // The lead product, plus invoice chasing so the fixture looks like a real
      // customer rather than one built to make this test pass.
      [{ moduleKey: "email_credit_controller" }, { moduleKey: "lead_follow_up_email" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      membersByRole.set(member.roleKey, member);
    }

    unentitledOrg = await createOrgWithMembers(owner, "leads-unentitled", ["owner"], undefined, [
      { moduleKey: "email_credit_controller" },
    ]);
    unentitledToken = await signToken({
      sub: unentitledOrg.members[0]!.authUserId,
      email: unentitledOrg.members[0]!.email,
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const logLead = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/organisations/${org.id}/leads`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  it("logs an enquiry and returns it with its evidence", async () => {
    const response = await logLead(tokens.get("sales")!, {
      source: "missed_call",
      contactName: "Priya Raman",
      contactPhone: "07700 900123",
      enquiry: "Wants a quote for a kitchen refit",
      receivedAt,
    }).expect(201);

    expect(response.body.status).toBe("new");
    expect(response.body.hasEvidence).toBe(true);
    expect(response.body.evidence.channel).toBe("missed_call");
    // ⚠️ THEIR CLOCK. The enquiry happened on the 17th; logging it later must
    // not restate it as having just arrived, or every speed-to-lead target
    // computed from it is a fiction.
    expect(new Date(response.body.receivedAt).toISOString()).toBe(receivedAt);
    expect(new Date(response.body.evidence.occurredAt).toISOString()).toBe(receivedAt);
  });

  /**
   * ⚠️ BRD 4.3, VERBATIM: "A lead without complete channel-appropriate evidence
   * must never enter the call queue." The lead and its evidence are written in
   * one transaction, so there is no window in which a lead exists unevidenced —
   * "we'll add it in a moment" is how that window becomes permanent.
   */
  it("never creates a lead without the evidence behind it", async () => {
    const response = await logLead(tokens.get("sales")!, {
      source: "callback_request",
      contactEmail: "priya@example.com",
      receivedAt,
    }).expect(201);

    const evidence = await owner.leadEvidence.findUnique({
      where: { leadId: response.body.id },
    });
    expect(evidence, "a lead was created with no evidence row").not.toBeNull();
    expect(evidence!.occurredAt.toISOString()).toBe(receivedAt);

    const orphans = await owner.lead.count({
      where: { organisationId: org.id, evidence: { is: null } },
    });
    expect(orphans, "an unevidenced lead exists in the book").toBe(0);
  });

  /**
   * ⚠️ THE DATABASE REFUSES, NOT THE SERVICE. `eva_app` holds no UPDATE on
   * `lead_evidence` (migration 0026), so there is no code path — present or
   * future, ours or a tidy-up script's — that can rewrite the proof of why
   * somebody was contacted. Asserted through the runtime role, because the test
   * client is the OWNER and the owner can do anything.
   */
  it("cannot alter evidence once written, even from inside the app", async () => {
    const rows = await owner.$queryRaw<{ has: boolean }[]>`
      SELECT has_table_privilege('eva_app', 'lead_evidence', 'UPDATE') AS has`;

    expect(rows[0]?.has, "the app role can rewrite compliance evidence").toBe(false);
  });

  /**
   * ⚠️ BRD 4.3: a do-not-contact request is actioned "immediately and
   * permanently… and applies across all channels". Marking only the lead would
   * leave the same person contactable the moment they enquire again, or through
   * a different product.
   */
  it("suppresses every channel we hold for them, not just the lead", async () => {
    const created = await logLead(tokens.get("reception")!, {
      source: "missed_call",
      contactName: "Alex Byrne",
      contactEmail: "Alex.Byrne@Example.com",
      contactPhone: "07700 900456",
      receivedAt,
    }).expect(201);

    const response = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/leads/${created.body.id}/do-not-contact`)
      .set("Authorization", `Bearer ${tokens.get("reception")!}`)
      .send({})
      .expect(201);

    expect(response.body.status).toBe("do_not_contact");

    const suppressed = await owner.suppressionEntry.findMany({
      where: { organisationId: org.id },
      select: { channel: true, value: true },
    });
    // ⚠️ `call`, NOT `phone` — the vocabulary slice 1.1 fixed, with a CHECK
    // behind it. A hand-written channel name would fail only here, in the path
    // nothing exercises until a real person asks not to be contacted.
    expect(suppressed).toContainEqual({ channel: "call", value: "07700 900456" });
    // Case-folded on the way in, so one person cannot slip through as two.
    expect(suppressed).toContainEqual({ channel: "email", value: "alex.byrne@example.com" });
  });

  it("is idempotent: asking twice does not fail and does not duplicate", async () => {
    const created = await logLead(tokens.get("sales")!, {
      source: "callback_request",
      contactEmail: "twice@example.com",
      receivedAt,
    }).expect(201);

    const url = `/organisations/${org.id}/leads/${created.body.id}/do-not-contact`;
    const token = tokens.get("sales")!;
    await request(app.getHttpServer())
      .post(url)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(url)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);

    const rows = await owner.suppressionEntry.count({
      where: { organisationId: org.id, channel: "email", value: "twice@example.com" },
    });
    expect(rows).toBe(1);
  });

  it("refuses a lead with no way to reach the person", async () => {
    await logLead(tokens.get("sales")!, {
      source: "missed_call",
      contactName: "No Contact Details",
      receivedAt,
    }).expect(400);
  });

  it("refuses a source we cannot yet produce", async () => {
    // `email` arrives in 3.1b, when there is a mailbox reader to create one.
    await logLead(tokens.get("sales")!, {
      source: "email",
      contactEmail: "someone@example.com",
      receivedAt,
    }).expect(400);
  });

  describe("who may do what", () => {
    it("lets sales and reception log an enquiry — it is their job", async () => {
      for (const role of ["sales", "reception", "owner"]) {
        await logLead(tokens.get(role)!, {
          source: "callback_request",
          contactPhone: `07700 9007${role.length}0`,
          receivedAt,
        }).expect(201);
      }
    });

    it("refuses write to a role that only reads", async () => {
      await logLead(tokens.get("read_only")!, {
        source: "callback_request",
        contactPhone: "07700 900999",
        receivedAt,
      }).expect(403);
    });

    /** Finance is deliberately out: an unanswered enquiry is not a receivable. */
    it("refuses finance entirely — leads are not a finance function", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${org.id}/leads`)
        .set("Authorization", `Bearer ${tokens.get("finance")!}`)
        .expect(403);
    });

    it("lets a read-only role see the book", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${org.id}/leads`)
        .set("Authorization", `Bearer ${tokens.get("read_only")!}`)
        .expect(200);
    });

    /**
     * ⚠️ THE ENTITLEMENT WALL. The lead record lives in the platform so that
     * follow-up by call and the CRM can share it later — but sharing the TABLE
     * must never mean sharing the DATA. A customer who bought only invoice
     * chasing has not bought this.
     */
    it("refuses an organisation that has not bought the lead product", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${unentitledOrg.id}/leads`)
        .set("Authorization", `Bearer ${unentitledToken}`)
        .expect(402);
    });
  });
});
