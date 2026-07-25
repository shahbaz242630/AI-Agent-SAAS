import { randomUUID } from "node:crypto";
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

describe("Schema conventions (BRD 10)", () => {
  it("creates exactly the Phase 0 + Slice 1.1 + Slice 1.2 + Slice 1.3 tables", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "_prisma_migrations",
      "audit_logs",
      "contacts",
      "customers",
      "import_rows",
      "imports",
      "invoices",
      "organisation_memberships",
      "organisation_role_permissions",
      "organisation_settings",
      "organisations",
      "roles",
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
    "suppression_list",
    "organisation_role_permissions",
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
    "organisation_role_permissions",
  ])("mutable table %s carries created_at/updated_at/created_by", async (table) => {
    const names = (await columnsOf(table)).map((c) => c.column_name);
    for (const col of ["created_at", "updated_at", "created_by"]) {
      expect(names, `${table} is missing ${col}`).toContain(col);
    }
  });

  it.each(["customers", "contacts", "invoices", "imports"])(
    "soft-deletable table %s has deleted_at",
    async (table) => {
      const names = (await columnsOf(table)).map((c) => c.column_name);
      expect(names).toContain("deleted_at");
    },
  );

  it("import_rows has no deleted_at: lifecycle follows the parent import (plan §3)", async () => {
    const names = (await columnsOf("import_rows")).map((c) => c.column_name);
    expect(names).not.toContain("deleted_at");
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
