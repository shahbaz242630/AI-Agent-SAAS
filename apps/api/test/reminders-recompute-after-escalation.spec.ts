import { randomUUID } from "node:crypto";
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
  TEST_INTERNAL_API_SECRET,
  type FixtureOrg,
} from "./support.js";

/**
 * Regression (found 2026-07-27 during the 1.5 staging e2e): org-wide recompute
 * after an escalation has fired — a human_escalations row plus a live ready
 * escalation action must not break step disable/re-enable, and the recomputed
 * invoice must keep exactly one live queue per step.
 */
const DAY_MS = 86_400_000;

describe("Reminders: step re-enable after escalation fired (regression)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let financeToken: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "repro500", ["finance"]);
    const finance = org.members[0]!;
    financeToken = await signToken({ sub: finance.authUserId, email: finance.email });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("disable then re-enable a step with a fired escalation in the org", async () => {
    const suffix = randomUUID().slice(0, 8);
    const customer = await owner.customer.create({
      data: { organisationId: org.id, name: `REPRO Customer ${suffix}` },
    });
    const contact = await owner.contact.create({
      data: {
        organisationId: org.id,
        customerId: customer.id,
        name: `REPRO Contact ${suffix}`,
        email: `repro-${suffix}@example.test`,
      },
    });
    const dueDate = new Date(Date.now() - 40 * DAY_MS).toISOString().slice(0, 10);
    const create = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customer.id}/invoices`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `REPRO-${suffix}`,
        amountMinorUnits: 5000,
        dueDate,
        contactId: contact.id,
        status: "active",
      })
      .expect(201);
    const invoiceId = (create.body as { id: string }).id;

    // Fire the escalation via the sweep.
    await request(app.getHttpServer())
      .post("/internal/reminders/reconcile")
      .set("x-internal-secret", TEST_INTERNAL_API_SECRET)
      .send({})
      .expect(200);
    const escalations = await owner.humanEscalation.findMany({ where: { invoiceId } });
    expect(escalations).toHaveLength(1);

    const sequence = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/reminder-sequence`)
      .set("Authorization", `Bearer ${financeToken}`)
      .expect(200);
    const step14 = (sequence.body as { steps: { id: string; key: string }[] }).steps.find(
      (s) => s.key === "overdue_14",
    )!;

    await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/reminder-sequence/steps/${step14.id}`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({ enabled: false })
      .expect(200);

    // Staging 500'd HERE (root cause: Prisma's 5s default interactive
    // transaction timeout at cloud latency — fixed via withTenant timeout).
    await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/reminder-sequence/steps/${step14.id}`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({ enabled: true })
      .expect(200);
  }, 120_000);
});
