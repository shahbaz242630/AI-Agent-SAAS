import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { ensureSystemStages } from "../src/platform/people/spine.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * The conversation behind an enquiry (slice 3.3c): `GET …/leads/:id/timeline`
 * over the `person_timeline` view.
 *
 * ⚠️ THE VIEW'S SECURITY IS `security_invoker`, AND THIS FILE PROVES IT FROM
 * THE OUTSIDE. `rls.spec.ts` in the database package proved that tenant A
 * reads an empty timeline for tenant B's person at the SQL level; here the
 * same claim is made through the real route, the real permission check and
 * the runtime role — which is the path a customer's browser takes.
 */
describe("Lead timeline: everything exchanged with the person", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let otherOrg: FixtureOrg;
  let unentitledOrg: FixtureOrg;
  const tokens = new Map<string, string>();
  let otherToken: string;
  let unentitledToken: string;

  const T0 = new Date("2026-09-04T09:00:00.000Z");
  const T1 = new Date("2026-09-04T09:05:00.000Z");
  const T2 = new Date("2026-09-04T09:10:00.000Z");
  const T3 = new Date("2026-09-04T09:15:00.000Z");

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();

    org = await createOrgWithMembers(
      owner,
      "timeline",
      ["owner", "read_only", "finance"],
      "Halloway Roofing",
      [{ moduleKey: "lead_follow_up" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
    otherOrg = await createOrgWithMembers(owner, "timeline-other", ["owner"], "Other Trades", [
      { moduleKey: "lead_follow_up" },
    ]);
    otherToken = await signToken({
      sub: otherOrg.members[0]!.authUserId,
      email: otherOrg.members[0]!.email,
    });
    unentitledOrg = await createOrgWithMembers(
      owner,
      "timeline-unentitled",
      ["owner"],
      "No Leads Ltd",
      [{ moduleKey: "email_credit_controller" }],
    );
    unentitledToken = await signToken({
      sub: unentitledOrg.members[0]!.authUserId,
      email: unentitledOrg.members[0]!.email,
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /**
   * A person with a history, written the way the spine writes it: an email
   * enquiry, Eva's reply, a note, and a later WhatsApp from the same person on
   * a second thread. Fixtures through the owner client — the door paths that
   * make these rows for real are proved in the 3.3b specs.
   */
  async function personWithHistory(fixture: FixtureOrg) {
    const address = `${randomUUID().slice(0, 8)}@example.com`;
    const waId = `4479${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const person = await owner.person.create({
      data: {
        organisationId: fixture.id,
        displayName: "Jane Smith",
        primaryEmail: address,
        identities: {
          create: [
            { organisationId: fixture.id, kind: "email", value: address, verification: "inbound" },
            { organisationId: fixture.id, kind: "wa_id", value: waId, verification: "inbound" },
          ],
        },
      },
      include: { identities: true },
    });
    const emailIdentity = person.identities.find((i) => i.kind === "email")!;
    const waIdentity = person.identities.find((i) => i.kind === "wa_id")!;
    const connection = await owner.channelConnection.create({
      data: {
        organisationId: fixture.id,
        moduleKey: "lead_follow_up",
        channel: "whatsapp",
        externalAccountId: `waba-${randomUUID().slice(0, 8)}`,
        externalAssetId: `pn-${randomUUID().slice(0, 8)}`,
      },
    });
    const emailThread = await owner.conversation.create({
      data: {
        organisationId: fixture.id,
        personId: person.id,
        personIdentityId: emailIdentity.id,
        channel: "email",
        status: "open",
        lastInboundAt: T0,
        lastOutboundAt: T1,
      },
    });
    const waThread = await owner.conversation.create({
      data: {
        organisationId: fixture.id,
        personId: person.id,
        personIdentityId: waIdentity.id,
        channel: "whatsapp",
        channelConnectionId: connection.id,
        status: "open",
        lastInboundAt: T3,
        replyWindowExpiresAt: new Date(T3.getTime() + 24 * 3600 * 1000),
      },
    });
    // A lead cannot exist without a stage (migration 0043); the same call the
    // real writers make.
    const stages = await ensureSystemStages(owner, fixture.id);
    const lead = await owner.lead.create({
      data: {
        organisationId: fixture.id,
        source: "email_enquiry",
        contactName: "Jane Smith",
        contactEmail: address,
        enquiry: "My roof is leaking.",
        receivedAt: T0,
        personId: person.id,
        pipelineStageId: stages.new,
        originConversationId: emailThread.id,
      },
    });
    await owner.conversation.update({ where: { id: emailThread.id }, data: { leadId: lead.id } });
    await owner.message.createMany({
      data: [
        {
          organisationId: fixture.id,
          conversationId: emailThread.id,
          personId: person.id,
          channel: "email",
          direction: "inbound",
          senderKind: "person",
          contentType: "text",
          subject: "Leaking roof",
          bodyText: "My roof is leaking.",
          sourceTable: "inbound_messages",
          sourceId: randomUUID(),
          occurredAt: T0,
        },
        {
          organisationId: fixture.id,
          conversationId: emailThread.id,
          personId: person.id,
          channel: "email",
          direction: "outbound",
          senderKind: "assistant",
          contentType: "text",
          subject: "Re: Leaking roof",
          bodyText: "Thanks for getting in touch.",
          sourceTable: "lead_reply_decisions",
          sourceId: randomUUID(),
          occurredAt: T1,
        },
        {
          organisationId: fixture.id,
          conversationId: waThread.id,
          personId: person.id,
          channel: "whatsapp",
          direction: "inbound",
          senderKind: "person",
          contentType: "media",
          subject: null,
          bodyText: null,
          sourceTable: "inbound_channel_messages",
          sourceId: randomUUID(),
          occurredAt: T3,
        },
      ],
    });
    await owner.activity.create({
      data: {
        organisationId: fixture.id,
        personId: person.id,
        leadId: lead.id,
        kind: "note",
        actorKind: "system",
        summary: "Filed under Halloway Roofing.",
        happenedAt: T2,
      },
    });
    return { person, lead, emailThread, waThread };
  }

  const get = (orgId: string, leadId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/organisations/${orgId}/leads/${leadId}/timeline`)
      .set("Authorization", `Bearer ${token}`);

  it("lists every message and activity for the person, oldest first, on every channel", async () => {
    const { lead, emailThread, waThread } = await personWithHistory(org);
    const response = await get(org.id, lead.id, tokens.get("owner")!).expect(200);

    const items = response.body as Array<Record<string, unknown>>;
    expect(items.map((i) => i.happenedAt)).toEqual([
      T0.toISOString(),
      T1.toISOString(),
      T2.toISOString(),
      T3.toISOString(),
    ]);
    expect(items[0]).toMatchObject({
      type: "message",
      channel: "email",
      detail: "inbound",
      actorKind: "person",
      subject: "Leaking roof",
      summary: "My roof is leaking.",
      conversationId: emailThread.id,
      leadId: null,
    });
    expect(items[1]).toMatchObject({
      type: "message",
      channel: "email",
      detail: "outbound",
      actorKind: "assistant",
      subject: "Re: Leaking roof",
      summary: "Thanks for getting in touch.",
    });
    expect(items[2]).toMatchObject({
      type: "activity",
      channel: null,
      detail: "note",
      actorKind: "system",
      subject: null,
      summary: "Filed under Halloway Roofing.",
      conversationId: null,
      leadId: lead.id,
    });
    // A WhatsApp from the same person, on its own thread, is on the same timeline.
    expect(items[3]).toMatchObject({
      type: "message",
      channel: "whatsapp",
      detail: "inbound",
      summary: null,
      conversationId: waThread.id,
    });
    for (const item of items) expect(typeof item.id).toBe("string");
  });

  /**
   * ⚠️ NOT A 404. A hand-logged enquiry carries a typed handle and no proof
   * of control, so 3.3b gave it no person on purpose; the screen must say
   * "nothing yet", not "that enquiry is not here".
   */
  it("is empty for an enquiry with no person, and that is not an error", async () => {
    const created = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/leads`)
      .set("Authorization", `Bearer ${tokens.get("owner")!}`)
      .send({
        source: "email_enquiry",
        contactEmail: `typed-${randomUUID().slice(0, 8)}@example.com`,
        receivedAt: T0.toISOString(),
      })
      .expect(201);
    const response = await get(org.id, created.body.id, tokens.get("owner")!).expect(200);
    expect(response.body).toEqual([]);
  });

  /**
   * 🚨 THE TENANT WALL, THROUGH THE ROUTE. The other organisation's owner is
   * a real user with the real permission on their own organisation; the
   * enquiry simply is not theirs. The answer is the same as for an id that
   * does not exist, so a wrong guess learns nothing.
   */
  it("answers 404 for another organisation's enquiry, and shows nothing of it", async () => {
    const { lead } = await personWithHistory(org);
    await get(otherOrg.id, lead.id, otherToken).expect(404);
    await get(org.id, randomUUID(), tokens.get("owner")!).expect(404);
  });

  it("reads through the view as the runtime role: another organisation's rows never appear", async () => {
    // Two people with histories, one per organisation; the view is queried by
    // person id under the caller's tenant, and `security_invoker` is what
    // keeps the other organisation's rows out even at the SQL level.
    const mine = await personWithHistory(org);
    await personWithHistory(otherOrg);
    const response = await get(org.id, mine.lead.id, tokens.get("owner")!).expect(200);
    const items = response.body as Array<{ conversationId: string | null }>;
    expect(items).toHaveLength(4);
    const threads = new Set(items.map((i) => i.conversationId).filter(Boolean));
    expect(threads).toEqual(new Set([mine.emailThread.id, mine.waThread.id]));
  });

  it("is readable by a read-only role and refused to finance", async () => {
    const { lead } = await personWithHistory(org);
    await get(org.id, lead.id, tokens.get("read_only")!).expect(200);
    await get(org.id, lead.id, tokens.get("finance")!).expect(403);
  });

  it("answers 402 for an organisation that has not bought the lead product", async () => {
    await get(unentitledOrg.id, randomUUID(), unentitledToken).expect(402);
  });
});
