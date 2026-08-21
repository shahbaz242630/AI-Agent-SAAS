import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import { createPrismaClient } from "../src/client.js";
import { DEMO_ORGANISATION_ID, seed } from "../src/seed.js";
import { TEST_DATABASE_URL } from "./support.js";

/**
 * RLS attack tests (BRD 13 security tests; Slice 0.3 + Slice 1.1).
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
  // Suppression rows are permanent and may be left by earlier test runs; clean
  // the deterministic fixture orgs so cross-tenant SELECT assertions are sound.
  await owner.$executeRaw`DELETE FROM suppression_events WHERE organisation_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`;
  // POSITIVE CONTROL for email_accounts (Slice 1.6): unlike customers/invoices,
  // seed() creates no mailbox rows, so "tenant A cannot SELECT tenant B's
  // email_accounts" would pass against an empty table whether the
  // tenant_isolation policy existed or not. Give it a row to hide — owned by
  // the DEMO org, which the ORG_A attacker context must not see.
  // Deliberately SOFT-DELETED: the cross-tenant SELECT below is unfiltered so a
  // soft-deleted row is an equally good control, and it occupies no slot in the
  // one-live-connection-per-org partial index, so specs sharing eva_test (and
  // running in parallel) cannot collide with it.
  await owner.$executeRaw`DELETE FROM email_accounts WHERE email_address = 'rls-fixture@example.com'`;
  // id and updated_at are NOT NULL with no database default (Prisma generates
  // both client-side), so raw SQL must supply them.
  await owner.$executeRaw`INSERT INTO email_accounts (id, organisation_id, provider, email_address, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, updated_at, deleted_at)
    VALUES (${randomUUID()}::uuid, ${DEMO_ORGANISATION_ID}::uuid, 'microsoft', 'rls-fixture@example.com', 'v1.aa.bb.cc', 'v1.aa.bb.cc', now() + interval '1 hour', ARRAY['Mail.Send'], now(), now())`;
  // POSITIVE CONTROL for organisation_modules (Slice 1.6a), for exactly the
  // same reason. The migration backfills only organisations that existed when
  // it ran, so whether the DEMO org has a row here depends on ordering — give
  // it one unconditionally, soft-deleted so it occupies no slot in the
  // one-live-row-per-(org, module) partial index and cannot collide with specs
  // running in parallel against eva_test.
  await owner.$executeRaw`DELETE FROM organisation_modules WHERE organisation_id = ${DEMO_ORGANISATION_ID}::uuid AND deleted_at IS NOT NULL`;
  await owner.$executeRaw`INSERT INTO organisation_modules (id, organisation_id, module_key, enabled, source, seats, updated_at, deleted_at)
    VALUES (${randomUUID()}::uuid, ${DEMO_ORGANISATION_ID}::uuid, 'voice_credit_controller', true, 'manual', 1, now(), now())`;
  await owner.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const TENANT_TABLES = [
  "organisations",
  "organisation_settings",
  "organisation_memberships",
  "users",
  "audit_logs",
  "customers",
  "contacts",
  "invoices",
  "imports",
  "import_rows",
  "invoice_documents",
  "suppression_events",
  "organisation_role_permissions",
  "reminder_sequences",
  "reminder_steps",
  "scheduled_actions",
  "human_escalations",
  "email_accounts",
  "organisation_modules",
  "leads",
  "lead_evidence",
  "consent_texts",
];

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
      WHERE relname IN (
        'organisations', 'organisation_settings', 'organisation_memberships',
        'users', 'audit_logs', 'customers', 'contacts', 'invoices',
        'imports', 'import_rows', 'invoice_documents', 'suppression_events',
        'organisation_role_permissions', 'reminder_sequences', 'reminder_steps',
        'scheduled_actions', 'human_escalations', 'email_accounts',
        'organisation_modules', 'leads', 'lead_evidence', 'consent_texts'
      )`;
    expect(rows.length).toBe(TENANT_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("every tenant-owned table has at least one policy", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string; count: bigint }[]>`
      SELECT tablename, COUNT(*) AS count FROM pg_policies
      WHERE tablename IN (
        'organisations', 'organisation_settings', 'organisation_memberships',
        'users', 'audit_logs', 'customers', 'contacts', 'invoices',
        'imports', 'import_rows', 'invoice_documents', 'suppression_events',
        'organisation_role_permissions', 'reminder_sequences', 'reminder_steps',
        'scheduled_actions', 'human_escalations', 'email_accounts',
        'organisation_modules', 'leads', 'lead_evidence', 'consent_texts'
      )
      GROUP BY tablename`;
    expect(rows.length).toBe(TENANT_TABLES.length);
    for (const row of rows) expect(Number(row.count)).toBeGreaterThan(0);
  });
});

describe("RLS: cross-tenant attacks are refused by Postgres itself", () => {
  it.each([
    "customers",
    "contacts",
    "invoices",
    "imports",
    "import_rows",
    "invoice_documents",
    "suppression_events",
    "organisation_role_permissions",
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
    "email_accounts",
    // Belongs here after all. An earlier version of this change pulled
    // organisation_modules out on the theory that migration 0017's backfill
    // gives ORG_A a row of its own — but ORG_A and ORG_B are SYNTHETIC tenant
    // contexts that never exist as organisations, so on a clean database they
    // own nothing in any table. That theory only looked right because this
    // developer's local database had a leftover organisation row carrying that
    // id; CI, which starts empty, said otherwise. The DEMO-owned control row
    // created in beforeAll is what stops this passing against an empty table.
    "organisation_modules",
  ])("tenant A cannot SELECT tenant B's %s", async (table) => {
    const visible = await asTenant(ORG_A, async (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM ${table}`),
    );
    expect(visible).toEqual([]);
  });

  /**
   * Entitlement is the thing that decides whether an organisation may use a
   * product at all, so granting yourself a module across a tenant boundary is
   * the single most valuable write an attacker could make here.
   *
   * `id` and `updated_at` are NOT NULL with no database default (Prisma
   * generates both client-side), so raw SQL must supply them — otherwise this
   * dies on a 23502 not-null violation BEFORE Postgres evaluates the policy and
   * passes for the wrong reason. That is the standing rule from slice 1.6,
   * where all eight of these tests had been passing vacuously since 1.1.
   */
  it("tenant A cannot INSERT an organisation module carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO organisation_modules (id, organisation_id, module_key, enabled, source, seats, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'ai_receptionist', true, 'manual', 99, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot UPDATE tenant B's seat count", async () => {
    // The UPDATE path matters independently: buying seats is a WITH CHECK
    // concern, and raising someone else's cap is as useful to an attacker as
    // creating a row. RLS filters the row out, so this is a silent no-op
    // rather than an error — assert nothing changed rather than a throw.
    const changed = await asTenant(ORG_A, async (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE organisation_modules SET seats = 99 WHERE organisation_id = '${ORG_B}'`,
      ),
    );
    expect(changed).toBe(0);
  });

  it("tenant A cannot INSERT a reminder sequence carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO reminder_sequences (id, organisation_id, name, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'PWN', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT a reminder step carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO reminder_steps (id, organisation_id, sequence_id, key, offset_days, action_type, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, ${randomUUID()}::uuid, 'due_date', 0, 'email', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT a scheduled action carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO scheduled_actions (id, organisation_id, invoice_id, reminder_step_id, action_type, scheduled_date, idempotency_key, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'email', CURRENT_DATE, ${randomUUID()}, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT a human escalation carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO human_escalations (id, organisation_id, invoice_id, scheduled_action_id, reason, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'final_reminder_escalation', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * `id` and `updated_at` are NOT NULL with no database default (Prisma
   * generates both client-side), so an INSERT omitting them dies on a 23502
   * not-null violation BEFORE Postgres evaluates the RLS policy — and
   * `rejects.toThrow()` cannot tell the two apart. Supplying every such column
   * is what makes this a real RLS test; asserting the message proves which
   * check refused us. Every INSERT attack in this describe was corrected the
   * same way in slice 1.6 — before that they all passed on the not-null
   * violation, so none of them actually exercised a policy.
   */
  it("cross-tenant INSERT into email_accounts is refused BY THE RLS POLICY", async () => {
    await expect(
      asTenant(
        ORG_A,
        (tx) =>
          tx.$executeRaw`INSERT INTO email_accounts (id, organisation_id, provider, email_address, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, updated_at)
        VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'microsoft', 'attacker@example.com', 'x', 'x', now(), ARRAY['Mail.Send'], now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT an invoice carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO invoices (id, organisation_id, customer_id, invoice_number, amount_minor_units, issue_date, due_date, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, ${randomUUID()}::uuid, 'PWN-1', 100, CURRENT_DATE, CURRENT_DATE, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT an import carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO imports (id, organisation_id, original_filename, file_type, mapping, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'pwn.csv', 'csv', '{}'::jsonb, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT an invoice document carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO invoice_documents (id, organisation_id, original_filename, size_bytes, content, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'pwn.pdf', 4, '\\x25504446'::bytea, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT a row carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`INSERT INTO customers (id, organisation_id, name, updated_at)
            VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'ACME', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot UPDATE tenant B's rows", async () => {
    const count = await asTenant(
      ORG_A,
      async (tx) =>
        tx.$executeRaw`UPDATE customers SET name = 'Pwned' WHERE organisation_id = ${ORG_B}::uuid`,
    );
    expect(Number(count)).toBe(0);
  });

  it("tenant A cannot DELETE tenant B's rows", async () => {
    const count = await asTenant(
      ORG_A,
      async (tx) => tx.$executeRaw`DELETE FROM customers WHERE organisation_id = ${ORG_B}::uuid`,
    );
    expect(Number(count)).toBe(0);
  });

  it.each([
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
    "email_accounts",
  ])("tenant A cannot UPDATE tenant B's %s rows", async (table) => {
    const count = await asTenant(ORG_A, async (tx) =>
      tx.$queryRawUnsafe(
        `UPDATE ${table} SET created_by = created_by WHERE organisation_id = '${ORG_B}'::uuid`,
      ),
    );
    expect(Number(count)).toBe(0);
  });

  it.each([
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
    "email_accounts",
  ])("tenant A cannot DELETE tenant B's %s rows", async (table) => {
    const count = await asTenant(ORG_A, async (tx) =>
      tx.$queryRawUnsafe(`DELETE FROM ${table} WHERE organisation_id = '${ORG_B}'::uuid`),
    );
    expect(Number(count)).toBe(0);
  });
});

describe("RLS: list_active_organisations sweep enumeration (migration 0010, plan §7.8)", () => {
  it("eva_app can EXECUTE the SECURITY DEFINER function without tenant context", async () => {
    // The ONLY controlled cross-tenant enumeration path: returns org ids, not rows.
    const rows = await prisma.$queryRaw<{ list_active_organisations: string }[]>`
      SELECT * FROM list_active_organisations()`;
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("RLS: suppression list permanence (BRD hard rule)", () => {
  it("runtime role has UPDATE and DELETE revoked on suppression_events", async () => {
    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`UPDATE suppression_events SET reason = 'tampered' WHERE organisation_id = ${ORG_A}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|cannot update/i);

    await expect(
      asTenant(
        ORG_A,
        async (tx) =>
          tx.$executeRaw`DELETE FROM suppression_events WHERE organisation_id = ${ORG_A}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|cannot delete/i);
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
    const updated = await prisma.role.updateMany({
      where: { key: "owner" },
      data: { name: "Hacker" },
    });
    expect(updated.count).toBe(0);
    const deleted = await prisma.role.deleteMany({ where: { key: "owner" } });
    expect(deleted.count).toBe(0);
  });
});
