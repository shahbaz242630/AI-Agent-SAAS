import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import { createPrismaClient } from "../src/client.js";
import { seed } from "../src/seed.js";
import { TEST_DATABASE_URL } from "./support.js";

/**
 * RLS attack tests (BRD 13 security tests; Slice 0.3).
 * These connect DIRECTLY to Postgres as the application runtime role
 * (eva_app — non-superuser, NOBYPASSRLS), bypassing all application code,
 * and attempt cross-tenant access. The database itself must refuse.
 */
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgresql://eva_app:eva_app@localhost:5432/eva_test";

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

let prisma: PrismaClient;

async function asTenant(orgId: string, fn: (tx: PrismaClient) => Promise<unknown>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_DATABASE_URL }) });
  // Self-sufficient fixtures: the seed is idempotent, and spec files must not
  // depend on run order (rls.spec runs before seed.spec alphabetically).
  const owner = createPrismaClient(TEST_DATABASE_URL);
  await seed(owner);
  await owner.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("RLS: connection role hardening", () => {
  it("connects as a non-superuser role without BYPASSRLS", async () => {
    const rows = await prisma.$queryRaw<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]?.rolname).toBe("eva_app");
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("every tenant-owned table has RLS enabled AND forced (owner bypass trap)", async () => {
    const rows = await prisma.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('organisations', 'organisation_settings', 'organisation_memberships', 'users', 'audit_logs')`;
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("every tenant-owned table has at least one policy", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string; count: bigint }[]>`
      SELECT tablename, COUNT(*) AS count FROM pg_policies
      WHERE tablename IN ('organisations', 'organisation_settings', 'organisation_memberships', 'users', 'audit_logs')
      GROUP BY tablename`;
    expect(rows.length).toBe(5);
    for (const row of rows) expect(Number(row.count)).toBeGreaterThan(0);
  });
});

describe("RLS: cross-tenant attacks are refused by Postgres itself", () => {
  it("tenant A cannot SELECT tenant B's organisations", async () => {
    const visible = await asTenant(
      ORG_A,
      async (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM organisations`,
    );
    expect(visible).toEqual([]);
  });

  it("tenant A cannot INSERT a row carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO organisation_settings (organisation_id) VALUES (${ORG_B}::uuid)`,
      ),
    ).rejects.toThrow();
  });

  it("tenant A cannot UPDATE tenant B's rows", async () => {
    const count = await asTenant(
      ORG_A,
      async (tx) =>
        tx.$executeRaw`UPDATE organisation_settings SET locale = 'fr-FR' WHERE organisation_id = ${ORG_B}::uuid`,
    );
    expect(Number(count)).toBe(0);
  });

  it("tenant A cannot DELETE tenant B's rows", async () => {
    const count = await asTenant(
      ORG_A,
      async (tx) =>
        tx.$executeRaw`DELETE FROM organisation_settings WHERE organisation_id = ${ORG_B}::uuid`,
    );
    expect(Number(count)).toBe(0);
  });
});

describe("RLS: shared reference tables (BRD 18 — roles are platform reference data)", () => {
  it("roles has RLS enabled with at least one policy (Supabase cloud parity)", async () => {
    const table = await prisma.$queryRaw<{ rowsecurity: boolean }[]>`
      SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'roles'`;
    expect(table[0]?.rowsecurity).toBe(true);

    const policies = await prisma.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'roles'`;
    expect(policies.length).toBeGreaterThan(0);
  });

  it("runtime role can SELECT roles (needed for membership writes)", async () => {
    const roles = await prisma.role.findMany();
    expect(roles.length).toBe(6);
  });

  it("runtime role cannot INSERT into roles", async () => {
    await expect(prisma.role.create({ data: { key: "hacker", name: "Hacker" } })).rejects.toThrow(
      /row-level security|permission denied/i,
    );
  });

  it("runtime role cannot UPDATE or DELETE roles (writes silently affect 0 rows)", async () => {
    // With only a FOR SELECT policy, UPDATE/DELETE see no writable rows —
    // Postgres refuses by making them no-ops, not by raising.
    const updated = await prisma.role.updateMany({ where: { key: "owner" }, data: { name: "Hacker" } });
    expect(updated.count).toBe(0);
    const deleted = await prisma.role.deleteMany({ where: { key: "owner" } });
    expect(deleted.count).toBe(0);
  });
});
