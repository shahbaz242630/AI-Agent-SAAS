import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { DEMO_ORGANISATION_ID, seed } from "../src/seed.js";
import { TEST_DATABASE_URL } from "./support.js";

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: string;
  data_type: string;
}

let prisma: EvaPrismaClient;

beforeAll(async () => {
  prisma = createPrismaClient(TEST_DATABASE_URL);
  // Self-sufficient fixtures: the demo org (invoice fixture parent) comes from
  // the idempotent seed; spec files must not depend on run order.
  await seed(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function columnsOf(table: string): Promise<ColumnRow[]> {
  return prisma.$queryRaw<ColumnRow[]>`
    SELECT table_name, column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
}

/** Self-sufficient fixture: a customer under the seeded demo org. */
async function invoiceFixtureCustomer() {
  const demo = await prisma.organisation.findUniqueOrThrow({ where: { id: DEMO_ORGANISATION_ID } });
  return prisma.customer.create({
    data: {
      id: randomUUID(),
      organisationId: demo.id,
      name: `Convention Fixture ${randomUUID().slice(0, 8)}`,
    },
  });
}

/** Self-sufficient fixture: invoice + reminder step to schedule actions against. */
async function scheduledActionFixture() {
  const customer = await invoiceFixtureCustomer();
  const invoice = await prisma.invoice.create({
    data: {
      organisationId: customer.organisationId,
      customerId: customer.id,
      invoiceNumber: `REM-${randomUUID().slice(0, 8)}`,
      amountMinorUnits: 100,
      issueDate: new Date(),
      dueDate: new Date(),
    },
  });
  const sequence = await prisma.reminderSequence.create({
    data: { organisationId: customer.organisationId, name: `SEQ-${randomUUID().slice(0, 8)}` },
  });
  const step = await prisma.reminderStep.create({
    data: {
      organisationId: customer.organisationId,
      sequenceId: sequence.id,
      key: "due_date",
      offsetDays: 0,
      actionType: "email",
    },
  });
  return { customer, invoice, sequence, step };
}

describe("Schema conventions (BRD 10)", () => {
  it("creates exactly the Phase 0 + Slice 1.1 + Slice 1.2 + Slice 1.3 + Slice 1.4 + Slice 1.5 tables", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "_prisma_migrations",
      "audit_logs",
      "contacts",
      "customers",
      "human_escalations",
      "import_rows",
      "imports",
      "invoice_documents",
      "invoices",
      "organisation_memberships",
      "organisation_role_permissions",
      "organisation_settings",
      "organisations",
      "reminder_sequences",
      "reminder_steps",
      "roles",
      "scheduled_actions",
      "suppression_list",
      "users",
    ]);
  });

  it.each([
    "organisation_settings",
    "organisation_memberships",
    "audit_logs",
    "customers",
    "contacts",
    "invoices",
    "imports",
    "import_rows",
    "invoice_documents",
    "suppression_list",
    "organisation_role_permissions",
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
  ])("tenant-owned table %s has a non-nullable organisation_id", async (table) => {
    const cols = await columnsOf(table);
    const orgColumn = cols.find((c) => c.column_name === "organisation_id");
    expect(orgColumn, `${table}.organisation_id must exist`).toBeDefined();
    expect(orgColumn?.is_nullable).toBe("NO");
  });

  it.each([
    "organisations",
    "organisation_settings",
    "users",
    "organisation_memberships",
    "customers",
    "contacts",
    "invoices",
    "imports",
    "import_rows",
    "invoice_documents",
    "organisation_role_permissions",
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
  ])("mutable table %s carries created_at/updated_at/created_by", async (table) => {
    const names = (await columnsOf(table)).map((c) => c.column_name);
    for (const col of ["created_at", "updated_at", "created_by"]) {
      expect(names, `${table} is missing ${col}`).toContain(col);
    }
  });

  it.each([
    "customers",
    "contacts",
    "invoices",
    "imports",
    "invoice_documents",
    "reminder_sequences",
    "reminder_steps",
  ])("soft-deletable table %s has deleted_at", async (table) => {
    const names = (await columnsOf(table)).map((c) => c.column_name);
    expect(names).toContain("deleted_at");
  });

  it("import_rows has no deleted_at: lifecycle follows the parent import (plan §3)", async () => {
    const names = (await columnsOf("import_rows")).map((c) => c.column_name);
    expect(names).not.toContain("deleted_at");
  });

  it("scheduled_actions and human_escalations have no deleted_at: lifecycle records, cancelled/resolved is terminal (plan §3)", async () => {
    for (const table of ["scheduled_actions", "human_escalations"]) {
      const names = (await columnsOf(table)).map((c) => c.column_name);
      expect(names, `${table} must not have deleted_at`).not.toContain("deleted_at");
    }
  });

  it("imports stores only csv/xlsx file types and the four stored statuses (CHECK constraints)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'imports'::regclass AND contype = 'c'`;
    const fileTypeCheck = rows.find((r) => r.pg_get_constraintdef.includes("file_type"));
    expect(fileTypeCheck).toBeDefined();
    for (const fileType of ["csv", "xlsx"]) {
      expect(fileTypeCheck?.pg_get_constraintdef).toContain(`'${fileType}'`);
    }
    const statusCheck = rows.find((r) => r.pg_get_constraintdef.includes("status"));
    expect(statusCheck).toBeDefined();
    for (const status of ["uploaded", "completed", "failed", "cancelled"]) {
      expect(statusCheck?.pg_get_constraintdef).toContain(`'${status}'`);
    }
  });

  it("import_rows stores only the six staged-row statuses (CHECK constraint)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'import_rows'::regclass AND contype = 'c'`;
    const statusCheck = rows.find((r) => r.pg_get_constraintdef.includes("status"));
    expect(statusCheck).toBeDefined();
    for (const status of ["valid", "invalid", "duplicate", "suppressed", "imported", "skipped"]) {
      expect(statusCheck?.pg_get_constraintdef).toContain(`'${status}'`);
    }
  });

  it("invoice_documents stores only the four stored statuses (CHECK constraint)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'invoice_documents'::regclass AND contype = 'c'`;
    const statusCheck = rows.find((r) => r.pg_get_constraintdef.includes("status"));
    expect(statusCheck).toBeDefined();
    for (const status of ["uploaded", "extracted", "confirmed", "failed"]) {
      expect(statusCheck?.pg_get_constraintdef).toContain(`'${status}'`);
    }
  });

  it("reminder_steps stores only the six BRD 4.1 stage keys and two action types (CHECK constraints)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'reminder_steps'::regclass AND contype = 'c'`;
    const keyCheck = rows.find((r) => r.pg_get_constraintdef.includes("key"));
    expect(keyCheck).toBeDefined();
    for (const key of [
      "pre_due_3",
      "due_date",
      "overdue_7",
      "overdue_14",
      "overdue_30",
      "final_escalation",
    ]) {
      expect(keyCheck?.pg_get_constraintdef).toContain(`'${key}'`);
    }
    const actionTypeCheck = rows.find((r) => r.pg_get_constraintdef.includes("action_type"));
    expect(actionTypeCheck).toBeDefined();
    for (const actionType of ["email", "internal_escalation"]) {
      expect(actionTypeCheck?.pg_get_constraintdef).toContain(`'${actionType}'`);
    }
  });

  it("scheduled_actions stores the full seven-state lifecycle and two action types (CHECK constraints)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'scheduled_actions'::regclass AND contype = 'c'`;
    const statusCheck = rows.find((r) => r.pg_get_constraintdef.includes("status"));
    expect(statusCheck).toBeDefined();
    for (const status of [
      "pending",
      "ready",
      "claimed",
      "sent",
      "failed",
      "skipped",
      "cancelled",
    ]) {
      expect(statusCheck?.pg_get_constraintdef).toContain(`'${status}'`);
    }
    const actionTypeCheck = rows.find((r) => r.pg_get_constraintdef.includes("action_type"));
    expect(actionTypeCheck).toBeDefined();
    for (const actionType of ["email", "internal_escalation"]) {
      expect(actionTypeCheck?.pg_get_constraintdef).toContain(`'${actionType}'`);
    }
  });

  it("human_escalations stores only open/resolved statuses (CHECK constraint)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'human_escalations'::regclass AND contype = 'c'`;
    const statusCheck = rows.find((r) => r.pg_get_constraintdef.includes("status"));
    expect(statusCheck).toBeDefined();
    for (const status of ["open", "resolved"]) {
      expect(statusCheck?.pg_get_constraintdef).toContain(`'${status}'`);
    }
  });

  it("one default reminder sequence per org among live rows (partial unique index)", async () => {
    const base = {
      organisationId: DEMO_ORGANISATION_ID,
      name: `SEQ-${randomUUID().slice(0, 8)}`,
      isDefault: true,
    };
    const first = await prisma.reminderSequence.create({ data: base });
    await expect(prisma.reminderSequence.create({ data: base })).rejects.toThrow();
    // A soft-deleted default no longer blocks a new one.
    await prisma.reminderSequence.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });
    const second = await prisma.reminderSequence.create({ data: base });
    // Fixture hygiene: deleting the sequence cascades to its steps.
    await prisma.reminderSequence.deleteMany({ where: { name: base.name } });
    expect(second.isDefault).toBe(true);
  });

  it("reminder step keys are unique per sequence among live rows (partial unique index)", async () => {
    const sequence = await prisma.reminderSequence.create({
      data: {
        organisationId: DEMO_ORGANISATION_ID,
        name: `SEQ-${randomUUID().slice(0, 8)}`,
      },
    });
    const step = {
      organisationId: DEMO_ORGANISATION_ID,
      sequenceId: sequence.id,
      key: "due_date",
      offsetDays: 0,
      actionType: "email",
    };
    const first = await prisma.reminderStep.create({ data: step });
    await expect(prisma.reminderStep.create({ data: step })).rejects.toThrow();
    // A soft-deleted step's key can be reused.
    await prisma.reminderStep.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    await prisma.reminderStep.create({ data: step });
    // Fixture hygiene: deleting the sequence cascades to its steps.
    await prisma.reminderSequence.delete({ where: { id: sequence.id } });
  });

  it("BRD 4.1 duplicate prevention: two concurrent schedules of the same (invoice, step, date) — exactly one succeeds", async () => {
    const { invoice, step } = await scheduledActionFixture();
    const scheduledDate = new Date();
    const data = {
      organisationId: DEMO_ORGANISATION_ID,
      invoiceId: invoice.id,
      reminderStepId: step.id,
      actionType: "email",
      scheduledDate,
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.allSettled([
      prisma.scheduledAction.create({ data }),
      prisma.scheduledAction.create({ data }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    // One escalation per fired step: the unique scheduled_action_id is the dedup.
    const [action] = await prisma.scheduledAction.findMany({
      where: { invoiceId: invoice.id, reminderStepId: step.id, scheduledDate },
    });
    const escalation = {
      organisationId: DEMO_ORGANISATION_ID,
      invoiceId: invoice.id,
      scheduledActionId: action!.id,
      reason: "final_reminder_escalation",
    };
    await prisma.humanEscalation.create({ data: escalation });
    await expect(prisma.humanEscalation.create({ data: escalation })).rejects.toThrow();

    // Fixture hygiene: invoice delete cascades actions → escalations; sequence
    // delete cascades steps; then remove the customer.
    await prisma.invoice.delete({ where: { id: invoice.id } });
    await prisma.reminderSequence.delete({ where: { id: step.sequenceId } });
    await prisma.customer.delete({ where: { id: invoice.customerId } });
  });

  it("every migration ships rollback guidance (forward-only convention, BRD 18)", () => {
    const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      expect(
        existsSync(path.join(migrationsDir, entry.name, "ROLLBACK.md")),
        `${entry.name} is missing ROLLBACK.md`,
      ).toBe(true);
    }
  });

  it("import_rows cascade with their import; created_invoice_id SET NULLs with the invoice", async () => {
    const customer = await invoiceFixtureCustomer();
    const invoice = await prisma.invoice.create({
      data: {
        organisationId: customer.organisationId,
        customerId: customer.id,
        invoiceNumber: `IMP-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
      },
    });
    const importRecord = await prisma.import.create({
      data: {
        organisationId: customer.organisationId,
        originalFilename: "ledger.csv",
        fileType: "csv",
        mapping: { "Invoice No": "invoiceNumber" },
      },
    });
    const row = await prisma.importRow.create({
      data: {
        organisationId: customer.organisationId,
        importId: importRecord.id,
        rowNumber: 1,
        raw: { "Invoice No": invoice.invoiceNumber },
        status: "imported",
        createdInvoiceId: invoice.id,
      },
    });

    // Deleting the invoice SET NULLs the back-reference (plan §3).
    await prisma.invoice.delete({ where: { id: invoice.id } });
    expect(
      (await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })).createdInvoiceId,
    ).toBeNull();

    // Deleting the import cascades to its staged rows (plan §3).
    await prisma.import.delete({ where: { id: importRecord.id } });
    expect(await prisma.importRow.findMany({ where: { importId: importRecord.id } })).toEqual([]);

    // Fixture hygiene: remove the customer this test created.
    await prisma.customer.delete({ where: { id: customer.id } });
  });

  it("invoices stores only the nine stored statuses (CHECK constraint)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; pg_get_constraintdef: string }[]>`
      SELECT conname, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = 'invoices'::regclass AND contype = 'c'`;
    const statusCheck = rows.find((r) => r.pg_get_constraintdef.includes("status"));
    expect(statusCheck).toBeDefined();
    for (const status of [
      "draft",
      "active",
      "paused",
      "cancelled",
      "promise_to_pay",
      "disputed",
      "partially_paid",
      "paid",
      "written_off",
    ]) {
      expect(statusCheck?.pg_get_constraintdef).toContain(`'${status}'`);
    }
  });

  it("invoices enforces positive amounts (CHECK constraint)", async () => {
    const customer = await invoiceFixtureCustomer();
    await expect(
      prisma.$executeRaw`
        INSERT INTO invoices (organisation_id, customer_id, invoice_number, amount_minor_units, issue_date, due_date)
        VALUES (${customer.organisationId}::uuid, ${customer.id}::uuid, 'NEG-1', -100, CURRENT_DATE, CURRENT_DATE)`,
    ).rejects.toThrow();
  });

  it("invoice numbers are unique per org among live rows, reusable after soft delete", async () => {
    const customer = await invoiceFixtureCustomer();
    const base = {
      organisationId: customer.organisationId,
      customerId: customer.id,
      invoiceNumber: `UNIQ-${randomUUID().slice(0, 8)}`,
      amountMinorUnits: 100,
      issueDate: new Date(),
      dueDate: new Date(),
    };
    const first = await prisma.invoice.create({ data: base });
    await expect(prisma.invoice.create({ data: base })).rejects.toThrow();
    await prisma.invoice.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    await prisma.invoice.create({ data: base });
    // Fixture hygiene: remove the rows this test created.
    await prisma.invoice.deleteMany({ where: { invoiceNumber: base.invoiceNumber } });
  });

  it("audit_logs is append-only: created_at + actor, no updated_at/deleted_at", async () => {
    const names = (await columnsOf("audit_logs")).map((c) => c.column_name);
    expect(names).toContain("created_at");
    expect(names).toContain("actor_user_id");
    expect(names).not.toContain("updated_at");
    expect(names).not.toContain("deleted_at");
  });

  it("suppression_list is permanent: created_at only, no updated_at/deleted_at", async () => {
    const names = (await columnsOf("suppression_list")).map((c) => c.column_name);
    expect(names).toContain("created_at");
    expect(names).toContain("created_by");
    expect(names).not.toContain("updated_at");
    expect(names).not.toContain("deleted_at");
  });

  it("stores timestamps as timestamptz (UTC, BRD 18.1)", async () => {
    const cols = await columnsOf("organisations");
    const createdAt = cols.find((c) => c.column_name === "created_at");
    expect(createdAt?.data_type).toBe("timestamp with time zone");
  });
});
