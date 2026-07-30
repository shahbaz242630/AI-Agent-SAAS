import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { seed, DEMO_ORGANISATION_ID } from "../src/seed.js";
import { withTenant, withUser } from "../src/tenant.js";
import { TEST_DATABASE_URL } from "./support.js";

const OWNER_URL = TEST_DATABASE_URL;
const APP_URL = OWNER_URL.replace("postgresql://eva:eva@", "postgresql://eva_app:eva_app@");

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ORG_ID = "00000000-0000-4000-8000-0000000000bb";

let owner: EvaPrismaClient;
let app: EvaPrismaClient;

beforeAll(async () => {
  owner = createPrismaClient(OWNER_URL);
  app = createPrismaClient(APP_URL);
  await seed(owner);
});

afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

describe("withTenant — app-layer tenant context (BRD 15)", () => {
  it("forwards transaction options (e.g. timeout) to $transaction", async () => {
    // The 1.5 step-edit recompute needs >5s at cloud latency (staging 500,
    // 2026-07-27) — withTenant must pass options through to Prisma.
    const calls: unknown[] = [];
    const stub = {
      $transaction: (fn: (tx: unknown) => unknown, options?: unknown) => {
        calls.push(options);
        return fn({
          $executeRaw: () => Promise.resolve(0),
        });
      },
    } as unknown as EvaPrismaClient;
    await withTenant(
      stub,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      () => Promise.resolve("ok"),
      { timeout: 30_000 },
    );
    expect(calls).toEqual([{ timeout: 30_000 }]);
  });

  it("sees the active tenant's rows", async () => {
    const orgs = await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      (tx) => tx.organisation.findMany(),
    );
    expect(orgs.map((o) => o.id)).toEqual([DEMO_ORGANISATION_ID]);
  });

  it("cannot see another tenant's rows", async () => {
    // Create a second org inside its own context (the API's create-org pattern).
    await withTenant(app, { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID }, async (tx) => {
      await tx.organisation.upsert({
        where: { id: SECOND_ORG_ID },
        update: {},
        create: { id: SECOND_ORG_ID, name: "Second Org Ltd" },
      });
    });

    const visibleToDemo = await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      (tx) => tx.organisation.findMany(),
    );
    expect(visibleToDemo.map((o) => o.id)).toEqual([DEMO_ORGANISATION_ID]);

    const visibleToSecond = await withTenant(
      app,
      { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID },
      (tx) => tx.organisation.findMany(),
    );
    expect(visibleToSecond.map((o) => o.id)).toEqual([SECOND_ORG_ID]);
  });

  it("fails closed: queries outside a tenant context see nothing", async () => {
    const orgs = await app.organisation.findMany();
    expect(orgs).toEqual([]);
  });

  it("rejects writes carrying another tenant's organisation_id", async () => {
    await expect(
      withTenant(app, { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID }, (tx) =>
        tx.organisationSettings.create({ data: { organisationId: SECOND_ORG_ID } }),
      ),
    ).rejects.toThrow();
  });

  it("scopes imports and their staged rows to the active tenant (Slice 1.3)", async () => {
    const importId = randomUUID();
    await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) => {
        await tx.import.create({
          data: {
            id: importId,
            organisationId: DEMO_ORGANISATION_ID,
            originalFilename: "ledger.csv",
            fileType: "csv",
            mapping: { "Invoice No": "invoiceNumber" },
          },
        });
        await tx.importRow.create({
          data: {
            organisationId: DEMO_ORGANISATION_ID,
            importId,
            rowNumber: 1,
            raw: { "Invoice No": "INV-1" },
            status: "valid",
          },
        });
      },
    );

    const visibleToSecond = await withTenant(
      app,
      { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID },
      async (tx) => ({
        imports: await tx.import.findMany(),
        rows: await tx.importRow.findMany(),
      }),
    );
    expect(visibleToSecond.imports).toEqual([]);
    expect(visibleToSecond.rows).toEqual([]);

    // Fixture hygiene: deleting the import cascades to its staged rows.
    await withTenant(app, { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID }, (tx) =>
      tx.import.delete({ where: { id: importId } }),
    );
  });

  it("scopes invoice documents to the active tenant (Slice 1.4)", async () => {
    const documentId = randomUUID();
    await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) => {
        await tx.invoiceDocument.create({
          data: {
            id: documentId,
            organisationId: DEMO_ORGANISATION_ID,
            originalFilename: "invoice.pdf",
            sizeBytes: 4,
            content: Buffer.from("%PDF"),
          },
        });
      },
    );

    const visibleToSecond = await withTenant(
      app,
      { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID },
      async (tx) => tx.invoiceDocument.findMany(),
    );
    expect(visibleToSecond).toEqual([]);

    // Fixture hygiene: remove the document this test created.
    await withTenant(app, { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID }, (tx) =>
      tx.invoiceDocument.delete({ where: { id: documentId } }),
    );
  });

  it("scopes reminder sequences, steps, scheduled actions and escalations to the active tenant (Slice 1.5)", async () => {
    const ids = { customer: randomUUID(), sequence: randomUUID(), action: randomUUID() };
    await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) => {
        const customer = await tx.customer.create({
          data: {
            id: ids.customer,
            organisationId: DEMO_ORGANISATION_ID,
            name: "Reminder Fixture Ltd",
          },
        });
        const invoice = await tx.invoice.create({
          data: {
            organisationId: DEMO_ORGANISATION_ID,
            customerId: customer.id,
            invoiceNumber: `REM-${randomUUID().slice(0, 8)}`,
            amountMinorUnits: 100,
            issueDate: new Date(),
            dueDate: new Date(),
          },
        });
        await tx.reminderSequence.create({
          data: {
            id: ids.sequence,
            organisationId: DEMO_ORGANISATION_ID,
            name: "Default",
            isDefault: true,
          },
        });
        const step = await tx.reminderStep.create({
          data: {
            organisationId: DEMO_ORGANISATION_ID,
            sequenceId: ids.sequence,
            key: "due_date",
            offsetDays: 0,
            actionType: "email",
          },
        });
        await tx.scheduledAction.create({
          data: {
            id: ids.action,
            organisationId: DEMO_ORGANISATION_ID,
            invoiceId: invoice.id,
            reminderStepId: step.id,
            actionType: "email",
            scheduledDate: new Date(),
            idempotencyKey: randomUUID(),
          },
        });
        await tx.humanEscalation.create({
          data: {
            organisationId: DEMO_ORGANISATION_ID,
            invoiceId: invoice.id,
            scheduledActionId: ids.action,
            reason: "final_reminder_escalation",
          },
        });
      },
    );

    const visibleToSecond = await withTenant(
      app,
      { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID },
      async (tx) => ({
        sequences: await tx.reminderSequence.findMany(),
        steps: await tx.reminderStep.findMany(),
        actions: await tx.scheduledAction.findMany(),
        escalations: await tx.humanEscalation.findMany(),
      }),
    );
    expect(visibleToSecond.sequences).toEqual([]);
    expect(visibleToSecond.steps).toEqual([]);
    expect(visibleToSecond.actions).toEqual([]);
    expect(visibleToSecond.escalations).toEqual([]);

    // Fixture hygiene: deleting the customer cascades invoice → scheduled
    // action → escalation; deleting the sequence cascades to its steps.
    await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) => {
        await tx.customer.delete({ where: { id: ids.customer } });
        await tx.reminderSequence.delete({ where: { id: ids.sequence } });
      },
    );
  });

  /** Slice 1.6: the app layer, as required alongside the direct-RLS attack in
   *  rls.spec.ts. A connected mailbox is the highest-value row in the schema —
   *  it holds the OAuth tokens Eva sends mail with. */
  it("scopes email_accounts to the current organisation", async () => {
    const created = await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) =>
        tx.emailAccount.create({
          data: {
            organisationId: DEMO_ORGANISATION_ID,
            provider: "microsoft",
            emailAddress: "tenant-scope-fixture@example.com",
            accessTokenEncrypted: "v1.aa.bb.cc",
            refreshTokenEncrypted: "v1.aa.bb.cc",
            tokenExpiresAt: new Date(Date.now() + 3_600_000),
            scopes: ["Mail.Send"],
          },
        }),
    );

    const visibleToSecond = await withTenant(
      app,
      { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID },
      async (tx) => tx.emailAccount.findMany(),
    );
    expect(visibleToSecond).toEqual([]);

    const visibleToDemo = await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) => tx.emailAccount.findMany({ where: { id: created.id } }),
    );
    expect(visibleToDemo).toHaveLength(1);

    // Hard delete, not soft: the one-live-connection-per-org partial index
    // would otherwise block later specs from connecting a mailbox.
    await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      async (tx) => tx.emailAccount.delete({ where: { id: created.id } }),
    );
  });
});

describe("withUser — login path (resolve my memberships before picking an org)", () => {
  it("sees only my own memberships", async () => {
    const memberships = await withUser(app, DEMO_USER_ID, (tx) =>
      tx.organisationMembership.findMany(),
    );
    expect(memberships.length).toBeGreaterThan(0);
    expect(memberships.every((m) => m.userId === DEMO_USER_ID)).toBe(true);
  });
});
