import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type EvaPrismaClient } from "@eva/database";
import { PrismaService } from "../src/common/database/prisma.service.js";
import {
  ensureSystemStages,
  recordInboundMessage,
  REPLY_WINDOW_MS,
  SYSTEM_STAGES,
  type InboundDelivery,
  type SpineWrite,
} from "../src/platform/people/spine.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  type FixtureOrg,
} from "./support.js";

/**
 * The spine's normaliser: one person, many handles, never guessed (slice
 * 3.3b; blueprint §3.3; rulings 66, 67, 75–77).
 *
 * ⚠️ RUN AS `eva_app`, UNDER RLS, THROUGH THE APP'S OWN CLIENT. The owner
 * client only sets fixtures up and reads results back. Every write the
 * normaliser makes goes through the grants migration 0041 handed the runtime
 * role — which is how "the view had full default grants" was caught in 3.3a,
 * and how a missing UPDATE on `person_identities` would be caught here.
 *
 * The rules come in the order they run: who, then the handles, then the
 * thread, then the message — and for each, the case that must fail.
 */
describe("The spine's normaliser: one person, many handles, never guessed", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let otherOrg: FixtureOrg;
  let connectionId: string;
  let otherConnectionId: string;

  const AT = new Date("2026-09-04T10:00:00.000Z");
  const LATER = new Date("2026-09-04T11:30:00.000Z");

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();

    org = await createOrgWithMembers(owner, "spine", ["owner"], "Halloway Roofing", [
      { moduleKey: "lead_follow_up" },
    ]);
    otherOrg = await createOrgWithMembers(owner, "spine-other", ["owner"], "Other Trades Ltd", [
      { moduleKey: "lead_follow_up" },
    ]);
    connectionId = (
      await owner.channelConnection.create({
        data: {
          organisationId: org.id,
          moduleKey: "lead_follow_up",
          channel: "whatsapp",
          externalAccountId: `waba-${randomUUID().slice(0, 8)}`,
          externalAssetId: `pn-${randomUUID().slice(0, 8)}`,
        },
        select: { id: true },
      })
    ).id;
    otherConnectionId = (
      await owner.channelConnection.create({
        data: {
          organisationId: otherOrg.id,
          moduleKey: "lead_follow_up",
          channel: "whatsapp",
          externalAccountId: `waba-${randomUUID().slice(0, 8)}`,
          externalAssetId: `pn-${randomUUID().slice(0, 8)}`,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /** The runtime role, inside a tenant transaction — exactly as intake runs. */
  const asTenant = <T>(fixture: FixtureOrg, fn: (tx: EvaPrismaClient) => Promise<T>) =>
    withTenant(
      app.get(PrismaService).db,
      { organisationId: fixture.id, userId: fixture.members[0]!.id },
      fn,
    );

  /** A fresh WhatsApp id per case: the handle index is unique per organisation. */
  const freshNumber = () => `4479${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  function whatsapp(
    waId: string,
    overrides: Partial<InboundDelivery> & { fixture?: FixtureOrg; connection?: string } = {},
  ): InboundDelivery {
    const { fixture, connection, ...rest } = overrides;
    return {
      organisationId: (fixture ?? org).id,
      channel: "whatsapp",
      channelConnectionId: connection ?? connectionId,
      sender: {
        displayName: "Jane Smith",
        handles: [
          { kind: "wa_id", value: waId },
          { kind: "phone", value: `+${waId}` },
        ],
      },
      providerMessageId: `wamid.${randomUUID()}`,
      providerThreadId: null,
      subject: null,
      bodyText: "Hi, my roof is leaking.",
      contentType: "text",
      sourceTable: "inbound_channel_messages",
      sourceId: randomUUID(),
      occurredAt: AT,
      ...rest,
    };
  }

  function email(address: string, overrides: Partial<InboundDelivery> = {}): InboundDelivery {
    return {
      organisationId: org.id,
      channel: "email",
      channelConnectionId: null,
      sender: { displayName: null, handles: [{ kind: "email", value: address }] },
      providerMessageId: `re_${randomUUID().slice(0, 8)}`,
      providerThreadId: `<${randomUUID().slice(0, 8)}@example.com>`,
      subject: "Leaking roof",
      bodyText: "Hello, my roof is leaking.",
      contentType: "text",
      sourceTable: "inbound_messages",
      sourceId: randomUUID(),
      occurredAt: AT,
      ...overrides,
    };
  }

  const identitiesOf = (personId: string) =>
    owner.personIdentity.findMany({ where: { personId }, orderBy: { kind: "asc" } });

  // -------------------------------------------------------------------------
  describe("a first message from a stranger", () => {
    it("makes the person, both handles proven, an open thread with its window, and the message", async () => {
      const waId = freshNumber();
      const write = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));

      expect(write.personCreated).toBe(true);
      expect(write.conversationOpened).toBe(true);
      expect(write.workingLeadId).toBeNull();
      expect(write.conflicts).toEqual([]);

      const person = await owner.person.findUniqueOrThrow({ where: { id: write.personId } });
      expect(person).toMatchObject({
        organisationId: org.id,
        displayName: "Jane Smith",
        primaryPhone: `+${waId}`,
        primaryEmail: null,
        createdBy: null,
      });

      const identities = await identitiesOf(write.personId);
      expect(identities.map((i) => [i.kind, i.value, i.verification])).toEqual([
        ["phone", `+${waId}`, "inbound"],
        ["wa_id", waId, "inbound"],
      ]);

      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: write.conversationId },
      });
      expect(thread).toMatchObject({
        organisationId: org.id,
        personId: write.personId,
        channel: "whatsapp",
        channelConnectionId: connectionId,
        status: "open",
        leadId: null,
        providerThreadId: null,
      });
      // The thread hangs off the WhatsApp id — the first handle — not the phone.
      expect(identities.find((i) => i.id === thread.personIdentityId)?.kind).toBe("wa_id");
      expect(thread.lastInboundAt?.toISOString()).toBe(AT.toISOString());
      expect(thread.replyWindowExpiresAt?.getTime()).toBe(AT.getTime() + REPLY_WINDOW_MS);

      const message = await owner.message.findUniqueOrThrow({ where: { id: write.messageId } });
      expect(message).toMatchObject({
        organisationId: org.id,
        conversationId: write.conversationId,
        personId: write.personId,
        channel: "whatsapp",
        direction: "inbound",
        senderKind: "person",
        contentType: "text",
        subject: null,
        bodyText: "Hi, my roof is leaking.",
        sourceTable: "inbound_channel_messages",
      });
      expect(message.occurredAt.toISOString()).toBe(AT.toISOString());
    });

    it("gives an email thread no window, and the RFC id a reply must quote", async () => {
      const address = `${randomUUID().slice(0, 8)}@example.com`;
      const delivery = email(address);
      const write = await asTenant(org, (tx) => recordInboundMessage(tx, delivery));

      const person = await owner.person.findUniqueOrThrow({ where: { id: write.personId } });
      // No name was given, so the person is known by their address — never blank.
      expect(person.displayName).toBe(address);
      expect(person.primaryEmail).toBe(address);

      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: write.conversationId },
      });
      expect(thread).toMatchObject({
        channel: "email",
        channelConnectionId: null,
        replyWindowExpiresAt: null,
        providerThreadId: delivery.providerThreadId,
      });
      const message = await owner.message.findUniqueOrThrow({ where: { id: write.messageId } });
      expect(message.subject).toBe("Leaking roof");
    });
  });

  // -------------------------------------------------------------------------
  describe("a second message from the same handle", () => {
    it("lands on the same person and the same thread, and moves the clocks forward", async () => {
      const waId = freshNumber();
      const first = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      const second = await asTenant(org, (tx) =>
        recordInboundMessage(tx, whatsapp(waId, { occurredAt: LATER })),
      );

      expect(second.personCreated).toBe(false);
      expect(second.personId).toBe(first.personId);
      expect(second.conversationOpened).toBe(false);
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.messageId).not.toBe(first.messageId);

      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: first.conversationId },
      });
      expect(thread.lastInboundAt?.toISOString()).toBe(LATER.toISOString());
      expect(thread.replyWindowExpiresAt?.getTime()).toBe(LATER.getTime() + REPLY_WINDOW_MS);
      expect(await owner.message.count({ where: { conversationId: first.conversationId } })).toBe(
        2,
      );
      expect(await owner.conversation.count({ where: { personId: first.personId } })).toBe(1);
    });

    it("does not move the clocks backwards for a retry of an older message", async () => {
      const waId = freshNumber();
      const first = await asTenant(org, (tx) =>
        recordInboundMessage(tx, whatsapp(waId, { occurredAt: LATER })),
      );
      await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId, { occurredAt: AT })));
      const thread = await owner.conversation.findUniqueOrThrow({
        where: { id: first.conversationId },
      });
      expect(thread.lastInboundAt?.toISOString()).toBe(LATER.toISOString());
    });

    it("writes one message for one raw row, however often it is asked", async () => {
      const waId = freshNumber();
      const delivery = whatsapp(waId);
      const first = await asTenant(org, (tx) => recordInboundMessage(tx, delivery));
      const again = await asTenant(org, (tx) => recordInboundMessage(tx, delivery));
      expect(again.messageId).toBe(first.messageId);
      expect(
        await owner.message.count({
          where: { sourceTable: delivery.sourceTable, sourceId: delivery.sourceId },
        }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("the identity rules", () => {
    /**
     * Ruling 77: a known client's WhatsApp lands on the person with the
     * invoice history. The client book typed the number (`none`); the message
     * arriving from it is the proof, so the handle is upgraded and the
     * WhatsApp id joins the same person.
     */
    it("finds a person by a handle the client book typed, and marks the handle proven", async () => {
      const waId = freshNumber();
      const client = await owner.person.create({
        data: {
          organisationId: org.id,
          displayName: "Acme Ltd (typed)",
          primaryPhone: `+${waId}`,
          identities: {
            create: {
              organisationId: org.id,
              kind: "phone",
              value: `+${waId}`,
              verification: "none",
            },
          },
        },
      });

      const write = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      expect(write.personCreated).toBe(false);
      expect(write.personId).toBe(client.id);
      expect(write.conflicts).toEqual([]);

      const identities = await identitiesOf(client.id);
      expect(identities.map((i) => [i.kind, i.verification])).toEqual([
        ["phone", "inbound"],
        ["wa_id", "inbound"],
      ]);
      // The name the book gave them is kept; the profile name is not a fact.
      const person = await owner.person.findUniqueOrThrow({ where: { id: client.id } });
      expect(person.displayName).toBe("Acme Ltd (typed)");
    });

    it("fills a blank primary handle from a proven one, and never overwrites a filled one", async () => {
      const address = `${randomUUID().slice(0, 8)}@example.com`;
      const waId = freshNumber();
      // Typed by the book with a number and an address, but the person row
      // only carries the number.
      const person = await owner.person.create({
        data: {
          organisationId: org.id,
          displayName: "Sam",
          primaryEmail: null,
          primaryPhone: `+${waId}`,
          identities: {
            create: [
              { organisationId: org.id, kind: "phone", value: `+${waId}`, verification: "none" },
              { organisationId: org.id, kind: "email", value: address, verification: "none" },
            ],
          },
        },
      });

      const write = await asTenant(org, (tx) => recordInboundMessage(tx, email(address)));
      expect(write.personId).toBe(person.id);

      const after = await owner.person.findUniqueOrThrow({ where: { id: person.id } });
      expect(after.primaryEmail, "the blank is filled from the proven handle").toBe(address);
      expect(after.primaryPhone, "what was there is left alone").toBe(`+${waId}`);
      const identities = await identitiesOf(person.id);
      expect(identities.map((i) => [i.kind, i.verification])).toEqual([
        ["email", "inbound"],
        // Nothing arrived from the number, so it is still only typed.
        ["phone", "none"],
      ]);
    });

    /**
     * 🚨 THE CASE THAT MUST FAIL. Blueprint §3.3 rule 4: never steal a handle.
     * The WhatsApp id belongs to one person and the phone to another; the
     * message resolves by the id, and the phone stays exactly where it was.
     */
    it("never steals a handle that belongs to another person", async () => {
      const waId = freshNumber();
      const holder = await owner.person.create({
        data: {
          organisationId: org.id,
          displayName: "Holder Of The Id",
          identities: {
            create: { organisationId: org.id, kind: "wa_id", value: waId, verification: "inbound" },
          },
        },
      });
      const other = await owner.person.create({
        data: {
          organisationId: org.id,
          displayName: "Owner Of The Phone",
          primaryPhone: `+${waId}`,
          identities: {
            create: {
              organisationId: org.id,
              kind: "phone",
              value: `+${waId}`,
              verification: "none",
            },
          },
        },
      });

      const write = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      expect(write.personId).toBe(holder.id);
      expect(write.conflicts).toEqual([{ kind: "phone", value: `+${waId}` }]);

      const phone = await owner.personIdentity.findUniqueOrThrow({
        where: {
          organisationId_kind_value: { organisationId: org.id, kind: "phone", value: `+${waId}` },
        },
      });
      expect(phone.personId, "the phone was repointed").toBe(other.id);
      expect(phone.verification, "a conflict is not proof for the other person").toBe("none");
      const holderNow = await owner.person.findUniqueOrThrow({ where: { id: holder.id } });
      expect(holderNow.primaryPhone, "a handle in conflict must not be copied over").toBeNull();
    });

    it("never matches by name", async () => {
      const address = `${randomUUID().slice(0, 8)}@example.com`;
      const jane = await owner.person.create({
        data: {
          organisationId: org.id,
          displayName: "Jane Smith",
          primaryEmail: address,
          identities: { create: { organisationId: org.id, kind: "email", value: address } },
        },
      });
      const write = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(freshNumber())));
      expect(write.personCreated).toBe(true);
      expect(write.personId).not.toBe(jane.id);
      expect(
        await owner.person.count({ where: { organisationId: org.id, displayName: "Jane Smith" } }),
      ).toBeGreaterThanOrEqual(2);
    });

    it("keeps two organisations apart: one number, two people", async () => {
      const waId = freshNumber();
      const here = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      const there = await asTenant(otherOrg, (tx) =>
        recordInboundMessage(
          tx,
          whatsapp(waId, { fixture: otherOrg, connection: otherConnectionId }),
        ),
      );
      expect(here.personCreated).toBe(true);
      expect(there.personCreated).toBe(true);
      expect(there.personId).not.toBe(here.personId);
      // Under RLS each side sees only its own row for the handle.
      const seenFromHere = await asTenant(org, (tx) =>
        tx.personIdentity.count({ where: { kind: "wa_id", value: waId } }),
      );
      expect(seenFromHere).toBe(1);
    });

    /**
     * ⚠️ THE CASES THAT MUST FAIL. An un-normalised handle would either be a
     * second identity for the same person (a mixed-case email) or a value the
     * CHECK refuses (a national phone). Either way: refused before anything is
     * written, so the raw row rolls back with it and the retry resumes.
     */
    it("refuses a handle that is not normalised, before anything is written", async () => {
      const before = await owner.person.count({ where: { organisationId: org.id } });
      await expect(
        asTenant(org, (tx) =>
          recordInboundMessage(tx, email("Jane@Example.com", { subject: "mixed case" })),
        ),
      ).rejects.toThrow(/not a normalised email/);
      await expect(
        asTenant(org, (tx) =>
          recordInboundMessage(
            tx,
            whatsapp("447911123456", {
              sender: { displayName: null, handles: [{ kind: "phone", value: "07911 123456" }] },
            }),
          ),
        ),
      ).rejects.toThrow(/not a normalised phone/);
      await expect(
        asTenant(org, (tx) =>
          recordInboundMessage(
            tx,
            whatsapp("x", {
              sender: { displayName: null, handles: [{ kind: "wa_id", value: "+447911123456" }] },
            }),
          ),
        ),
      ).rejects.toThrow(/not a normalised wa_id/);
      expect(await owner.person.count({ where: { organisationId: org.id } })).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  describe("ruling 76: the thread decides whether this is a new enquiry", () => {
    async function leadOn(write: SpineWrite, phone: string): Promise<string> {
      // A lead cannot exist without a stage (migration 0043).
      const stages = await ensureSystemStages(owner, org.id);
      const lead = await owner.lead.create({
        data: {
          organisationId: org.id,
          source: "whatsapp_enquiry",
          contactPhone: phone,
          receivedAt: AT,
          personId: write.personId,
          pipelineStageId: stages.new,
          originConversationId: write.conversationId,
        },
        select: { id: true },
      });
      await owner.conversation.update({
        where: { id: write.conversationId },
        data: { leadId: lead.id },
      });
      return lead.id;
    }

    it("reports the live lead an open thread is working", async () => {
      const waId = freshNumber();
      const first = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      expect(first.workingLeadId).toBeNull();
      const leadId = await leadOn(first, `+${waId}`);

      const second = await asTenant(org, (tx) =>
        recordInboundMessage(tx, whatsapp(waId, { occurredAt: LATER })),
      );
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.workingLeadId).toBe(leadId);
    });

    it("reports nothing for a lead that has since been retired, on the same thread", async () => {
      const waId = freshNumber();
      const first = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      const leadId = await leadOn(first, `+${waId}`);
      await owner.lead.update({ where: { id: leadId }, data: { deletedAt: new Date() } });

      const second = await asTenant(org, (tx) =>
        recordInboundMessage(tx, whatsapp(waId, { occurredAt: LATER })),
      );
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.workingLeadId).toBeNull();
    });

    it("opens a new thread, and so a new enquiry, once the old one is resolved", async () => {
      const waId = freshNumber();
      const first = await asTenant(org, (tx) => recordInboundMessage(tx, whatsapp(waId)));
      await leadOn(first, `+${waId}`);
      await owner.conversation.update({
        where: { id: first.conversationId },
        data: { status: "resolved", resolvedAt: new Date() },
      });

      const second = await asTenant(org, (tx) =>
        recordInboundMessage(tx, whatsapp(waId, { occurredAt: LATER })),
      );
      expect(second.personId).toBe(first.personId);
      expect(second.conversationOpened).toBe(true);
      expect(second.conversationId).not.toBe(first.conversationId);
      expect(second.workingLeadId).toBeNull();
      expect(await owner.conversation.count({ where: { personId: first.personId } })).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("the system stages", () => {
    it("seeds the eight for an organisation that has none, exactly once", async () => {
      const fresh = await createOrgWithMembers(owner, "spine-stages", ["owner"], "New Org Ltd", [
        { moduleKey: "lead_follow_up" },
      ]);
      expect(await owner.pipelineStage.count({ where: { organisationId: fresh.id } })).toBe(0);

      const first = await asTenant(fresh, (tx) => ensureSystemStages(tx, fresh.id));
      expect(Object.keys(first).sort()).toEqual(SYSTEM_STAGES.map((s) => s.key).sort());
      const rows = await owner.pipelineStage.findMany({
        where: { organisationId: fresh.id },
        orderBy: { position: "asc" },
      });
      expect(rows.map((r) => [r.systemKey, r.name, r.position])).toEqual(
        SYSTEM_STAGES.map((s) => [s.key, s.name, s.position]),
      );

      const second = await asTenant(fresh, (tx) => ensureSystemStages(tx, fresh.id));
      expect(second).toEqual(first);
      expect(await owner.pipelineStage.count({ where: { organisationId: fresh.id } })).toBe(8);
      expect(
        await owner.auditLog.count({
          where: { organisationId: fresh.id, action: "pipeline_stage.system_seeded" },
        }),
      ).toBe(1);
    });

    it("puts back a missing stage without touching the rest", async () => {
      const fresh = await createOrgWithMembers(owner, "spine-stages-2", ["owner"], "Gap Ltd", [
        { moduleKey: "lead_follow_up" },
      ]);
      const first = await asTenant(fresh, (tx) => ensureSystemStages(tx, fresh.id));
      // Only the owner can hard-delete; the runtime role holds no DELETE.
      await owner.pipelineStage.delete({ where: { id: first.quoted } });

      const again = await asTenant(fresh, (tx) => ensureSystemStages(tx, fresh.id));
      expect(again.quoted).not.toBe(first.quoted);
      expect(again.new).toBe(first.new);
      expect(again.lost).toBe(first.lost);
      expect(await owner.pipelineStage.count({ where: { organisationId: fresh.id } })).toBe(8);
    });
  });
});
