import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type EvaPrismaClient } from "@eva/database";
import { auditReassignedByMailbox, writeAuditLog } from "../src/platform/audit/audit-log.js";
import { PrismaService } from "../src/common/database/prisma.service.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  type FixtureOrg,
} from "./support.js";

/**
 * One clock across audit_logs.
 *
 * `audit_logs.created_at` is `DEFAULT CURRENT_TIMESTAMP` — TRANSACTION START in
 * Postgres — while every Prisma-written audit row is stamped from the API's own
 * clock at the moment of the call. `auditReassignedByMailbox` is the only writer
 * that goes through raw SQL, so for as long as it let the default apply, the two
 * disagreed and a single replace produced an impossible story: clients filed
 * under a mailbox BEFORE that mailbox was created.
 *
 * Found on staging 2026-08-03 (`customer.reassigned` at 11:13:44.912, the
 * mailbox they moved to created at 11:13:45.954), not by any test.
 *
 * ⚠️ Everything here runs on the APP's RLS-scoped connection inside a real
 * tenant transaction, because transaction start time is the whole subject — a
 * test that wrote these rows outside a transaction could not fail.
 */

describe("audit_logs timestamps (one clock)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let userId: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "audit-clock", ["owner"], "Audit Clock Ltd", [
      { moduleKey: "email_credit_controller", seats: 4 },
    ]);
    userId = org.members[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  async function addMailbox(label: string) {
    return owner.emailAccount.create({
      data: {
        organisationId: org.id,
        // Invoice Chasing: the only product that could own a mailbox
        // before migration 0034, so every existing fixture is one.
        moduleKey: "email_credit_controller",
        provider: "microsoft",
        emailAddress: `${label}-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: false,
      },
    });
  }

  async function addClient(emailAccountId: string) {
    return owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: `Client ${randomUUID().slice(0, 8)}`,
        emailAccountId,
      },
    });
  }

  /**
   * The replace shape, reduced to the two writes that disagreed: a mailbox
   * created through Prisma, then its book audited through raw SQL — both in ONE
   * transaction, exactly as `connect` does them.
   */
  it("stamps a reassign after the mailbox it moved clients to, not at transaction start", async () => {
    const from = await addMailbox("from");
    const client = await addClient(from.id);

    const { txStart, to, moved } = await withTenant(
      app.get(PrismaService).db,
      { organisationId: org.id, userId },
      async (tx) => {
        // Transaction start, straight from the database — this is the value the
        // column default would have applied.
        const [start] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

        const created = await tx.emailAccount.create({
          data: {
            organisationId: org.id,
            // Invoice Chasing: the only product that could own a mailbox
            // before migration 0034, so every existing fixture is one.
            moduleKey: "email_credit_controller",
            provider: "microsoft",
            emailAddress: `to-${randomUUID().slice(0, 8)}@example.com`,
            isPrimary: false,
          },
        });
        const count = await auditReassignedByMailbox(tx, {
          organisationId: org.id,
          actorUserId: userId,
          fromEmailAccountId: from.id,
          toEmailAccountId: created.id,
          reason: "mailbox_replaced",
        });
        return { txStart: start!.now, to: created, moved: count };
      },
    );

    expect(moved).toBe(1);
    const [row] = await owner.auditLog.findMany({
      where: { action: "customer.reassigned", entityId: client.id },
    });

    // THE DEFECT: this is what the column default produced — every reassign row
    // pinned to the instant the transaction opened.
    expect(row!.createdAt.getTime()).toBeGreaterThan(txStart.getTime());

    // THE CONSEQUENCE: the trail has to describe something that could happen.
    // A client cannot be filed under a mailbox that does not exist yet.
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(to.createdAt.getTime());
  });

  /**
   * The property the first test protects, stated the way a reader of the trail
   * meets it: sort the rows and the sequence must make sense.
   */
  it("orders a reassign after the mailbox.connected row written before it", async () => {
    const from = await addMailbox("ordered-from");
    const client = await addClient(from.id);
    const marker = randomUUID();

    await withTenant(app.get(PrismaService).db, { organisationId: org.id, userId }, async (tx) => {
      const created = await tx.emailAccount.create({
        data: {
          organisationId: org.id,
          // Invoice Chasing: the only product that could own a mailbox
          // before migration 0034, so every existing fixture is one.
          moduleKey: "email_credit_controller",
          provider: "microsoft",
          emailAddress: `ordered-to-${randomUUID().slice(0, 8)}@example.com`,
          isPrimary: false,
        },
      });
      await writeAuditLog(tx, {
        organisationId: org.id,
        actorUserId: userId,
        action: "mailbox.connected",
        entityType: "email_account",
        entityId: created.id,
        metadata: { marker },
      });
      await auditReassignedByMailbox(tx, {
        organisationId: org.id,
        actorUserId: userId,
        fromEmailAccountId: from.id,
        toEmailAccountId: created.id,
        reason: "mailbox_replaced",
      });
    });

    const [connected] = await owner.auditLog.findMany({
      where: { action: "mailbox.connected", metadata: { path: ["marker"], equals: marker } },
    });
    const [reassigned] = await owner.auditLog.findMany({
      where: { action: "customer.reassigned", entityId: client.id },
    });

    expect(connected).toBeDefined();
    expect(reassigned).toBeDefined();
    expect(reassigned!.createdAt.getTime()).toBeGreaterThanOrEqual(connected!.createdAt.getTime());
  });
});
