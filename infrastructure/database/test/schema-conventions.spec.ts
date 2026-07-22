import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { TEST_DATABASE_URL } from "./support.js";

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: string;
  data_type: string;
}

let prisma: EvaPrismaClient;

beforeAll(() => {
  prisma = createPrismaClient(TEST_DATABASE_URL);
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

describe("Phase 0 schema conventions (BRD 10)", () => {
  it("creates exactly the Phase 0 tables — no future-module tables (Rule 11)", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "_prisma_migrations",
      "audit_logs",
      "organisation_memberships",
      "organisation_settings",
      "organisations",
      "roles",
      "users",
    ]);
  });

  it.each(["organisation_settings", "organisation_memberships", "audit_logs"])(
    "tenant-owned table %s has a non-nullable organisation_id",
    async (table) => {
      const cols = await columnsOf(table);
      const orgColumn = cols.find((c) => c.column_name === "organisation_id");
      expect(orgColumn, `${table}.organisation_id must exist`).toBeDefined();
      expect(orgColumn?.is_nullable).toBe("NO");
    },
  );

  it.each(["organisations", "organisation_settings", "users", "organisation_memberships"])(
    "mutable table %s carries audit and soft-delete columns",
    async (table) => {
      const names = (await columnsOf(table)).map((c) => c.column_name);
      for (const col of ["created_at", "updated_at", "created_by", "deleted_at"]) {
        expect(names, `${table} is missing ${col}`).toContain(col);
      }
    },
  );

  it("audit_logs is append-only: created_at + actor, no updated_at/deleted_at", async () => {
    const names = (await columnsOf("audit_logs")).map((c) => c.column_name);
    expect(names).toContain("created_at");
    expect(names).toContain("actor_user_id");
    expect(names).not.toContain("updated_at");
    expect(names).not.toContain("deleted_at");
  });

  it("stores timestamps as timestamptz (UTC, BRD 18.1)", async () => {
    const cols = await columnsOf("organisations");
    const createdAt = cols.find((c) => c.column_name === "created_at");
    expect(createdAt?.data_type).toBe("timestamp with time zone");
  });
});
