import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { TEST_DATABASE_URL } from "./support.js";

/**
 * Slice 3.3a — the lead spine (migration 0041).
 *
 * Two halves. The first proves the SHAPE: the CHECKs and unique indexes that
 * make "one handle, one person" and "one open thread per handle" facts about
 * the database rather than habits of the code. The second proves the BACKFILL,
 * by running the migration's own text.
 *
 * ⚠️ WHY THE BACKFILL IS TESTED BY RE-RUNNING ITS TEXT. CI creates `eva_test`
 * empty and migrates it before any spec inserts a row, so when 0041 ran here
 * every source table was empty and "every lead older than the migration has a
 * person" cannot fail — the same trap `schema-conventions.spec.ts` records for
 * 0020. So this file seeds the shapes production actually holds (a client, a
 * person at that client, enquiries by email and by hand, one WhatsApp, one
 * reply Eva sent), lifts the block between `BACKFILL BEGIN` / `BACKFILL END`
 * out of `migration.sql`, and runs it twice. The second run must create
 * nothing, because production is migrated exactly once and a re-runnable
 * block is the only kind that can be tested at all.
 *
 * Connected as the OWNER, which bypasses RLS exactly as the migration role
 * does — the backfill is cross-organisation by nature.
 */
const prisma: EvaPrismaClient = createPrismaClient(TEST_DATABASE_URL);

const MIGRATION = "20260904120000_the_spine";

function backfillStatements(): string[] {
  const sql = readFileSync(
    path.join(
      fileURLToPath(new URL("../prisma/migrations", import.meta.url)),
      MIGRATION,
      "migration.sql",
    ),
    "utf8",
  );
  const begin = sql.indexOf("-- BACKFILL BEGIN");
  const end = sql.indexOf("-- BACKFILL END");
  // Positive control on the extraction itself: an empty block would make
  // every assertion below fail loudly rather than pass on nothing.
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const block = sql
    .slice(begin, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const statements = block
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  expect(statements.length).toBeGreaterThan(10);
  return statements;
}

async function runBackfill(): Promise<void> {
  const statements = backfillStatements();
  // One interactive transaction pins one connection, which is what the
  // block's temporary tables need.
  await prisma.$transaction(
    async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 60_000 },
  );
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("The spine's shape: what the database refuses (migration 0041)", () => {
  let organisationId: string;
  let personId: string;

  beforeAll(async () => {
    const organisation = await prisma.organisation.create({
      data: { name: `Spine Shape ${randomUUID().slice(0, 8)}` },
    });
    organisationId = organisation.id;
    const person = await prisma.person.create({
      data: { organisationId, displayName: "Shape Fixture" },
    });
    personId = person.id;
  });

  afterAll(async () => {
    await prisma.organisation.delete({ where: { id: organisationId } });
  });

  it("refuses a handle that is not normalised — mixed-case email, phone with spaces, unknown kind", async () => {
    for (const bad of [
      { kind: "email", value: "Jane@Example.com" },
      { kind: "email", value: "not-an-email" },
      { kind: "phone", value: "+44 7700 900123" },
      { kind: "phone", value: "07700900123" },
      { kind: "wa_id", value: "+447700900123" },
      { kind: "messenger_psid", value: "1234567890" },
    ]) {
      await expect(
        prisma.personIdentity.create({ data: { organisationId, personId, ...bad } }),
        `${bad.kind} ${bad.value} must be refused`,
      ).rejects.toThrow();
    }
  });

  it("one handle belongs to one person: a second person cannot claim it, even inactive", async () => {
    const value = `only-once-${randomUUID().slice(0, 8)}@example.com`;
    await prisma.personIdentity.create({
      data: { organisationId, personId, kind: "email", value, status: "inactive" },
    });
    const other = await prisma.person.create({ data: { organisationId, displayName: "Other" } });
    await expect(
      prisma.personIdentity.create({
        data: { organisationId, personId: other.id, kind: "email", value },
      }),
      // Prisma reports a unique violation by its columns, not the index name.
    ).rejects.toThrow(
      /Unique constraint failed on the fields: \(`organisation_id`, `kind`, `value`\)/,
    );
  });

  it("the same handle in ANOTHER organisation is a different person — two rows, no cross-tenant link", async () => {
    const value = `two-orgs-${randomUUID().slice(0, 8)}@example.com`;
    await prisma.personIdentity.create({
      data: { organisationId, personId, kind: "email", value },
    });
    const elsewhere = await prisma.organisation.create({
      data: { name: `Spine Elsewhere ${randomUUID().slice(0, 8)}` },
    });
    const stranger = await prisma.person.create({
      data: { organisationId: elsewhere.id, displayName: "Same Handle, Other Business" },
    });
    const identity = await prisma.personIdentity.create({
      data: { organisationId: elsewhere.id, personId: stranger.id, kind: "email", value },
    });
    expect(identity.personId).not.toBe(personId);
    await prisma.organisation.delete({ where: { id: elsewhere.id } });
  });

  it("one OPEN thread per handle; a resolved one frees the slot", async () => {
    const identity = await prisma.personIdentity.create({
      data: {
        organisationId,
        personId,
        kind: "email",
        value: `thread-${randomUUID().slice(0, 8)}@example.com`,
      },
    });
    const thread = { organisationId, personId, personIdentityId: identity.id, channel: "email" };
    const first = await prisma.conversation.create({ data: thread });
    await expect(prisma.conversation.create({ data: thread })).rejects.toThrow(
      /Unique constraint failed on the fields: \(`organisation_id`, `person_identity_id`/,
    );
    await prisma.conversation.update({
      where: { id: first.id },
      data: { status: "resolved", resolvedAt: new Date() },
    });
    const second = await prisma.conversation.create({ data: thread });
    expect(second.id).not.toBe(first.id);
  });

  it("a WhatsApp thread must name our number, an email thread must not, and email has no window", async () => {
    const identity = await prisma.personIdentity.create({
      data: { organisationId, personId, kind: "wa_id", value: "447700900001" },
    });
    await expect(
      prisma.conversation.create({
        data: { organisationId, personId, personIdentityId: identity.id, channel: "whatsapp" },
      }),
    ).rejects.toThrow(/conversations_asset_check/);
    await expect(
      prisma.conversation.create({
        data: {
          organisationId,
          personId,
          personIdentityId: identity.id,
          channel: "email",
          replyWindowExpiresAt: new Date(),
        },
      }),
    ).rejects.toThrow(/conversations_window_check/);
  });

  it("a resolved thread carries resolved_at, and an open one does not", async () => {
    const identity = await prisma.personIdentity.create({
      data: {
        organisationId,
        personId,
        kind: "email",
        value: `resolved-${randomUUID().slice(0, 8)}@example.com`,
      },
    });
    const base = { organisationId, personId, personIdentityId: identity.id, channel: "email" };
    await expect(
      prisma.conversation.create({ data: { ...base, status: "resolved" } }),
    ).rejects.toThrow(/conversations_resolved_at_check/);
    await expect(
      prisma.conversation.create({ data: { ...base, resolvedAt: new Date() } }),
    ).rejects.toThrow(/conversations_resolved_at_check/);
  });

  it("an inbound message is from the person and an outbound one never is; WhatsApp has no subject", async () => {
    const identity = await prisma.personIdentity.create({
      data: {
        organisationId,
        personId,
        kind: "email",
        value: `message-${randomUUID().slice(0, 8)}@example.com`,
      },
    });
    const conversation = await prisma.conversation.create({
      data: { organisationId, personId, personIdentityId: identity.id, channel: "email" },
    });
    const base = {
      organisationId,
      personId,
      conversationId: conversation.id,
      channel: "email",
      contentType: "text",
      sourceTable: "inbound_messages",
      occurredAt: new Date(),
    };
    await expect(
      prisma.message.create({
        data: { ...base, direction: "inbound", senderKind: "assistant", sourceId: randomUUID() },
      }),
    ).rejects.toThrow(/messages_sender_matches_direction_check/);
    await expect(
      prisma.message.create({
        data: { ...base, direction: "outbound", senderKind: "person", sourceId: randomUUID() },
      }),
    ).rejects.toThrow(/messages_sender_matches_direction_check/);
    await expect(
      prisma.message.create({
        data: {
          ...base,
          channel: "whatsapp",
          direction: "inbound",
          senderKind: "person",
          subject: "no subjects on WhatsApp",
          sourceId: randomUUID(),
        },
      }),
    ).rejects.toThrow(/messages_subject_is_email_only_check/);
  });

  it("one canonical message per raw delivery — the same source row cannot be written twice", async () => {
    const identity = await prisma.personIdentity.create({
      data: {
        organisationId,
        personId,
        kind: "email",
        value: `source-${randomUUID().slice(0, 8)}@example.com`,
      },
    });
    const conversation = await prisma.conversation.create({
      data: { organisationId, personId, personIdentityId: identity.id, channel: "email" },
    });
    const data = {
      organisationId,
      personId,
      conversationId: conversation.id,
      channel: "email",
      direction: "inbound",
      senderKind: "person",
      contentType: "text",
      sourceTable: "inbound_messages",
      sourceId: randomUUID(),
      occurredAt: new Date(),
    };
    await prisma.message.create({ data });
    await expect(prisma.message.create({ data })).rejects.toThrow(
      /Unique constraint failed on the fields: \(`source_table`, `source_id`\)/,
    );
  });

  it("a system stage is unique per organisation and cannot be retired; a custom one can", async () => {
    await prisma.pipelineStage.create({
      data: { organisationId, systemKey: "new", name: "New", position: 1 },
    });
    await expect(
      prisma.pipelineStage.create({
        data: { organisationId, systemKey: "new", name: "New again", position: 2 },
      }),
    ).rejects.toThrow(
      /Unique constraint failed on the fields: \(`organisation_id`, `system_key`\)/,
    );
    await expect(
      prisma.pipelineStage.updateMany({
        where: { organisationId, systemKey: "new" },
        data: { deletedAt: new Date() },
      }),
    ).rejects.toThrow(/pipeline_stages_system_stage_is_permanent_check/);
    const custom = await prisma.pipelineStage.create({
      data: { organisationId, name: "Waiting on parts", position: 9 },
    });
    await prisma.pipelineStage.update({
      where: { id: custom.id },
      data: { deletedAt: new Date() },
    });
    // And the retired name is free again — the partial index covers live rows.
    await prisma.pipelineStage.create({
      data: { organisationId, name: "waiting on parts", position: 10 },
    });
  });

  it("a human activity names the human; a machine one must not", async () => {
    await expect(
      prisma.activity.create({
        data: { organisationId, personId, kind: "note", actorKind: "user", summary: "unnamed" },
      }),
    ).rejects.toThrow(/activities_actor_user_check/);
    await expect(
      prisma.activity.create({
        data: {
          organisationId,
          personId,
          kind: "note",
          actorKind: "system",
          actorUserId: randomUUID(),
          summary: "named machine",
        },
      }),
    ).rejects.toThrow(/activities_actor_user_check|violates foreign key/);
  });

  it("leads.source now admits whatsapp_enquiry, and lead_evidence.channel moved with it", async () => {
    const rows = await prisma.$queryRaw<{ conrelid: string; def: string }[]>`
      SELECT conrelid::regclass::text AS conrelid, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname IN ('leads_source_check', 'lead_evidence_channel_check')`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.def, row.conrelid).toContain("'whatsapp_enquiry'");
      expect(row.def, row.conrelid).toContain("'email_enquiry'");
    }
  });
});

describe("The backfill: every row that already exists finds its place (migration 0041)", () => {
  const t = {
    first: new Date("2026-08-20T10:00:00.000Z"),
    reply: new Date("2026-08-20T11:00:00.000Z"),
    second: new Date("2026-08-22T09:00:00.000Z"),
    whatsapp: new Date("2026-09-03T18:03:58.000Z"),
  };

  let organisationId: string;
  let customerId: string;
  const leads: Record<string, string> = {};
  let connectionId: string;

  const counts = async () => ({
    people: await prisma.person.count({ where: { organisationId } }),
    identities: await prisma.personIdentity.count({ where: { organisationId } }),
    conversations: await prisma.conversation.count({ where: { organisationId } }),
    messages: await prisma.message.count({ where: { organisationId } }),
    stages: await prisma.pipelineStage.count({ where: { organisationId } }),
  });

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const organisation = await prisma.organisation.create({
      data: { name: `Spine Backfill ${suffix}` },
    });
    organisationId = organisation.id;

    // 0. The eight system stages, the way 0041's backfill seeds them for an
    //    organisation with none — created here because migration 0043 made a
    //    lead without a stage impossible, so the fixture's enquiries must be
    //    born staged. The backfill's own seed step finds them and skips them.
    const stageIds: Record<string, string> = {};
    for (const [position, [key, name]] of (
      [
        ["new", "New"],
        ["contacted", "Contacted"],
        ["qualified", "Qualified"],
        ["quoted", "Quoted"],
        ["booked", "Booked"],
        ["done", "Done"],
        ["reviewed", "Reviewed"],
        ["lost", "Lost"],
      ] as const
    ).entries()) {
      const row = await prisma.pipelineStage.create({
        data: { organisationId, systemKey: key, name, position: position + 1 },
        select: { id: true },
      });
      stageIds[key] = row.id;
    }

    // 1. A client with a handle, typed with the mess real data has.
    const customer = await prisma.customer.create({
      data: {
        organisationId,
        name: "Acme Roofing",
        email: " Jane@Acme.com ",
        phone: "+44 7700 900123",
      },
    });
    customerId = customer.id;

    // 2. A person at that client, with a national-format phone (no country —
    //    not something the backfill may guess at).
    await prisma.contact.create({
      data: {
        organisationId,
        customerId,
        name: "Bob Builder",
        email: "bob@acme.com",
        phone: "07700 900999",
      },
    });

    // 3. Enquiries. Jane twice by email (with the deliveries that made them);
    //    a stranger by email with no delivery (hand-logged, the 3.1a shape);
    //    a phone-only enquiry from the founder's shape; a do-not-contact; and
    //    one whose "email" is not one — the case that must produce nothing.
    const address = await prisma.inboundAddress.create({
      data: {
        organisationId,
        address: `spine-${suffix}@inbound.example.com`,
        localPart: `spine-${suffix}`,
        domain: "inbound.example.com",
      },
    });
    const lead = (data: {
      key: string;
      contactName?: string;
      contactEmail?: string;
      contactPhone?: string;
      receivedAt: Date;
      firstRespondedAt?: Date;
      status?: string;
    }) =>
      prisma.lead
        .create({
          data: {
            organisationId,
            source: "email_enquiry",
            contactName: data.contactName,
            contactEmail: data.contactEmail,
            contactPhone: data.contactPhone,
            enquiry: `enquiry ${data.key}`,
            receivedAt: data.receivedAt,
            firstRespondedAt: data.firstRespondedAt,
            status: data.status ?? "new",
            // Staged the way the backfill staged production on 2026-09-04:
            // `contacted` where Eva had answered, `new` everywhere else. The
            // backfill's own stage step (`WHERE pipeline_stage_id IS NULL`)
            // can no longer fire on anything — see the stage test below.
            pipelineStageId: data.firstRespondedAt ? stageIds.contacted! : stageIds.new!,
          },
        })
        .then((row) => {
          leads[data.key] = row.id;
          return row;
        });

    await lead({
      key: "jane1",
      contactName: "Jane Smith",
      contactEmail: "jane@acme.com",
      contactPhone: "+44 7700 900123",
      receivedAt: t.first,
      firstRespondedAt: t.reply,
    });
    await lead({ key: "stranger", contactEmail: "stranger@example.com", receivedAt: t.first });
    await lead({
      key: "jane2",
      contactName: "Jane Smith",
      contactEmail: "JANE@acme.com",
      receivedAt: t.second,
    });
    await lead({
      key: "founder",
      contactName: "Shahbaz",
      contactPhone: "+971 50 000 0001",
      receivedAt: t.first,
    });
    await lead({
      key: "dnc",
      contactEmail: "dnc@example.com",
      receivedAt: t.first,
      status: "do_not_contact",
    });
    await lead({ key: "junk", contactEmail: "not-an-email", receivedAt: t.first });

    const delivery = (leadKey: string, rfc: string, receivedAt: Date, subject: string) =>
      prisma.inboundMessage.create({
        data: {
          organisationId,
          inboundAddressId: address.id,
          provider: "resend",
          providerMessageId: `resend-${randomUUID()}`,
          rfcMessageId: rfc,
          fromAddress: "Jane Smith <jane@acme.com>",
          deliveredTo: address.address,
          subject,
          textBody: `body of ${subject}`,
          status: "converted",
          leadId: leads[leadKey],
          receivedAt,
        },
      });
    await delivery("jane1", "<first@acme.com>", t.first, "Roof leak");
    await delivery("jane2", "<second@acme.com>", t.second, "Roof leak again");

    // 4. The reply Eva sent to the first enquiry.
    await prisma.leadReplyDecision.create({
      data: {
        organisationId,
        leadId: leads.jane1!,
        channel: "email",
        verdict: "reply",
        reason: "A genuine enquiry",
        signal: "rule:genuine",
        status: "sent",
        toAddress: "jane@acme.com",
        subject: "Re: Roof leak",
        body: "Thanks Jane, we will be in touch.",
        sentAt: t.reply,
        sentFrom: "office@customer.example.com",
      },
    });

    // 5. One WhatsApp from the founder's number, on a connected number of ours.
    const connection = await prisma.channelConnection.create({
      data: {
        organisationId,
        moduleKey: "lead_follow_up",
        channel: "whatsapp",
        externalAccountId: `waba-${suffix}`,
        externalAssetId: `phone-${suffix}`,
        displayName: "+1 555 197 4045",
      },
    });
    connectionId = connection.id;
    await prisma.inboundChannelMessage.create({
      data: {
        organisationId,
        connectionId,
        channel: "whatsapp",
        providerMessageId: `wamid.${suffix}`,
        fromIdentifier: "971500000001",
        fromDisplayName: "Shahbaz Malik",
        messageType: "text",
        textBody: "Hey partner how we doing",
        payload: {},
        status: "received",
        receivedAt: t.whatsapp,
      },
    });

    await runBackfill();
  });

  afterAll(async () => {
    // A delivery RESTRICTs its connection (0040), so it goes before the
    // organisation cascade takes everything else.
    await prisma.inboundChannelMessage.deleteMany({ where: { organisationId } });
    await prisma.organisation.delete({ where: { id: organisationId } });
  });

  it("seeds the eight system stages for the organisation", async () => {
    const stages = await prisma.pipelineStage.findMany({
      where: { organisationId },
      orderBy: { position: "asc" },
    });
    expect(stages.map((s) => s.systemKey)).toEqual([
      "new",
      "contacted",
      "qualified",
      "quoted",
      "booked",
      "done",
      "reviewed",
      "lost",
    ]);
  });

  it("makes ONE person for Jane — the client wins the handle, and both her enquiries point at her", async () => {
    // By handle, not by client: Bob is AT the client too, so two people carry
    // its `customer_id` — a person at a client belongs to that client.
    const jane = await prisma.person.findFirstOrThrow({
      where: { organisationId, primaryEmail: "jane@acme.com" },
      include: { identities: { orderBy: { kind: "asc" } } },
    });
    // The client record's name, normalised handles, and the phone the
    // enquiry and the client share — once.
    expect(jane.displayName).toBe("Acme Roofing");
    expect(jane.customerId).toBe(customerId);
    expect(jane.primaryPhone).toBe("+447700900123");
    expect(
      await prisma.person.count({ where: { organisationId, primaryEmail: "jane@acme.com" } }),
    ).toBe(1);
    expect(jane.identities.map((i) => [i.kind, i.value, i.verification])).toEqual([
      // A delivery arrived from this address, so it is proven — even though
      // the client book typed it first.
      ["email", "jane@acme.com", "inbound"],
      ["phone", "+447700900123", "none"],
    ]);
    const [first, second] = await Promise.all([
      prisma.lead.findUniqueOrThrow({ where: { id: leads.jane1 } }),
      prisma.lead.findUniqueOrThrow({ where: { id: leads.jane2 } }),
    ]);
    expect(first.personId).toBe(jane.id);
    expect(second.personId).toBe(jane.id);
  });

  it("gives Bob an email identity and NO phone identity — a national number is not guessed at", async () => {
    const bob = await prisma.person.findFirstOrThrow({
      where: { organisationId, primaryEmail: "bob@acme.com" },
      include: { identities: true },
    });
    expect(bob.displayName).toBe("Bob Builder");
    expect(bob.customerId).toBe(customerId);
    expect(bob.primaryPhone).toBeNull();
    expect(bob.identities.map((i) => i.kind)).toEqual(["email"]);
  });

  it("opens ONE email thread for Jane, pointing at her newest enquiry, threaded on her first message", async () => {
    const threads = await prisma.conversation.findMany({
      where: { organisationId, channel: "email" },
      include: { messages: { orderBy: { occurredAt: "asc" } } },
    });
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    expect(thread!.status).toBe("open");
    expect(thread!.leadId).toBe(leads.jane2);
    expect(thread!.providerThreadId).toBe("<first@acme.com>");
    expect(thread!.channelConnectionId).toBeNull();
    expect(thread!.replyWindowExpiresAt).toBeNull();
    expect(thread!.lastInboundAt).toEqual(t.second);
    expect(thread!.lastOutboundAt).toEqual(t.reply);
    expect(thread!.createdAt).toEqual(t.first);
    // Two deliveries in, one reply out, in the order they happened.
    expect(
      thread!.messages.map((m) => [m.direction, m.senderKind, m.sourceTable, m.subject]),
    ).toEqual([
      ["inbound", "person", "inbound_messages", "Roof leak"],
      ["outbound", "assistant", "lead_reply_decisions", "Re: Roof leak"],
      ["inbound", "person", "inbound_messages", "Roof leak again"],
    ]);
    // Both enquiries remember the thread that opened them.
    const [first, second] = await Promise.all([
      prisma.lead.findUniqueOrThrow({ where: { id: leads.jane1 } }),
      prisma.lead.findUniqueOrThrow({ where: { id: leads.jane2 } }),
    ]);
    expect(first.originConversationId).toBe(thread!.id);
    expect(second.originConversationId).toBe(thread!.id);
  });

  it("attaches the founder's WhatsApp id to the person the phone-only enquiry made, with the 24-hour window", async () => {
    const founder = await prisma.lead.findUniqueOrThrow({
      where: { id: leads.founder },
      include: { person: { include: { identities: { orderBy: { kind: "asc" } } } } },
    });
    expect(founder.person).not.toBeNull();
    expect(founder.person!.displayName).toBe("Shahbaz");
    expect(founder.person!.identities.map((i) => [i.kind, i.value, i.verification])).toEqual([
      ["phone", "+971500000001", "inbound"],
      ["wa_id", "971500000001", "inbound"],
    ]);
    // Hand-logged: no delivery, so no thread of its own.
    expect(founder.originConversationId).toBeNull();

    const thread = await prisma.conversation.findFirstOrThrow({
      where: { organisationId, channel: "whatsapp" },
      include: { messages: true },
    });
    expect(thread.personId).toBe(founder.person!.id);
    expect(thread.channelConnectionId).toBe(connectionId);
    expect(thread.leadId).toBeNull();
    expect(thread.lastInboundAt).toEqual(t.whatsapp);
    expect(thread.replyWindowExpiresAt).toEqual(new Date(t.whatsapp.getTime() + 24 * 3_600_000));
    expect(
      thread.messages.map((m) => [m.direction, m.contentType, m.bodyText, m.sourceTable]),
    ).toEqual([["inbound", "text", "Hey partner how we doing", "inbound_channel_messages"]]);
  });

  it("gives the hand-logged stranger and the do-not-contact enquiry a person each, and no thread", async () => {
    for (const key of ["stranger", "dnc"]) {
      const row = await prisma.lead.findUniqueOrThrow({
        where: { id: leads[key] },
        include: { person: { include: { identities: true } } },
      });
      expect(row.person, key).not.toBeNull();
      expect(
        row.person!.identities.map((i) => i.verification),
        key,
      ).toEqual(["none"]);
      expect(row.originConversationId, key).toBeNull();
    }
    const dnc = await prisma.lead.findUniqueOrThrow({ where: { id: leads.dnc } });
    // A status, not a stage: untouched.
    expect(dnc.status).toBe("do_not_contact");
  });

  it("THE CASE THAT MUST FAIL: an enquiry whose email is not one gets no person", async () => {
    const junk = await prisma.lead.findUniqueOrThrow({ where: { id: leads.junk } });
    expect(junk.personId).toBeNull();
    expect(junk.originConversationId).toBeNull();
    expect(
      await prisma.personIdentity.count({ where: { organisationId, value: "not-an-email" } }),
    ).toBe(0);
  });

  /**
   * ⚠️ WEAKER THAN IT WAS, AND SAID SO. Until migration 0043 this fixture
   * created stage-less leads and asserted the backfill staged them —
   * `contacted` where Eva had answered, `new` everywhere else. A NOT NULL
   * column cannot hold that shape, so the fixture now creates its enquiries
   * already staged that way, and what this proves is that the backfill leaves
   * an existing stage alone. The null case ran once, on production, on
   * 2026-09-04, and is history the database no longer admits.
   */
  it("leaves every enquiry's stage where it was: contacted where Eva answered, new everywhere else", async () => {
    const rows = await prisma.lead.findMany({
      where: { organisationId },
      include: { pipelineStage: true },
    });
    const byKey = Object.fromEntries(
      Object.entries(leads).map(([key, id]) => [key, rows.find((r) => r.id === id)!.pipelineStage]),
    );
    expect(byKey.jane1?.systemKey).toBe("contacted");
    for (const key of ["jane2", "stranger", "founder", "dnc", "junk"]) {
      expect(byKey[key]?.systemKey, key).toBe("new");
    }
  });

  it("counts: five people, seven handles, two threads, four messages", async () => {
    expect(await counts()).toEqual({
      people: 5,
      identities: 7,
      conversations: 2,
      messages: 4,
      stages: 8,
    });
  });

  it("is idempotent: a second run creates nothing", async () => {
    const before = await counts();
    await runBackfill();
    expect(await counts()).toEqual(before);
  });

  it("the timeline view lists Jane's three items in the order they happened", async () => {
    const jane = await prisma.person.findFirstOrThrow({
      where: { organisationId, primaryEmail: "jane@acme.com" },
    });
    const rows = await prisma.$queryRaw<
      { item_type: string; detail: string; summary: string | null; happened_at: Date }[]
    >`
      SELECT item_type, detail, summary, happened_at
      FROM person_timeline
      WHERE person_id = ${jane.id}::uuid
      ORDER BY happened_at ASC`;
    expect(rows.map((r) => [r.item_type, r.detail, r.summary])).toEqual([
      ["message", "inbound", "body of Roof leak"],
      ["message", "outbound", "Thanks Jane, we will be in touch."],
      ["message", "inbound", "body of Roof leak again"],
    ]);
  });
});
