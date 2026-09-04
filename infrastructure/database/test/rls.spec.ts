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
  await owner.$executeRaw`INSERT INTO email_accounts (id, organisation_id, module_key, provider, email_address, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, updated_at, deleted_at)
    VALUES (${randomUUID()}::uuid, ${DEMO_ORGANISATION_ID}::uuid, 'email_credit_controller', 'microsoft', 'rls-fixture@example.com', 'v1.aa.bb.cc', 'v1.aa.bb.cc', now() + interval '1 hour', ARRAY['Mail.Send'], now(), now())`;
  // POSITIVE CONTROL for organisation_modules (Slice 1.6a), for exactly the
  // same reason. The migration backfills only organisations that existed when
  // it ran, so whether the DEMO org has a row here depends on ordering — give
  // it one unconditionally, soft-deleted so it occupies no slot in the
  // one-live-row-per-(org, module) partial index and cannot collide with specs
  // running in parallel against eva_test.
  await owner.$executeRaw`DELETE FROM organisation_modules WHERE organisation_id = ${DEMO_ORGANISATION_ID}::uuid AND deleted_at IS NOT NULL`;
  await owner.$executeRaw`INSERT INTO organisation_modules (id, organisation_id, module_key, enabled, source, seats, updated_at, deleted_at)
    VALUES (${randomUUID()}::uuid, ${DEMO_ORGANISATION_ID}::uuid, 'voice_credit_controller', true, 'manual', 1, now(), now())`;
  // POSITIVE CONTROL for the lead spine (slice 3.3a, migration 0041): one
  // person under the DEMO org with a handle, a thread, a message, an activity
  // and a custom stage — a row in every spine table for the ORG_A attacker
  // context to fail to see. The seed creates none, and the migration's
  // backfill ran against an empty database, so without these every spine
  // assertion below would pass against nothing. Deleting the person cascades
  // the rest; the stage is deleted on its own.
  await owner.$executeRaw`DELETE FROM people WHERE id = ${SPINE_PERSON_ID}::uuid`;
  await owner.$executeRaw`DELETE FROM pipeline_stages WHERE id = ${SPINE_STAGE_ID}::uuid`;
  await owner.$executeRaw`INSERT INTO people (id, organisation_id, display_name, primary_email)
    VALUES (${SPINE_PERSON_ID}::uuid, ${DEMO_ORGANISATION_ID}::uuid, 'RLS Fixture Person', 'rls-fixture-person@example.com')`;
  await owner.$executeRaw`INSERT INTO person_identities (id, organisation_id, person_id, kind, value)
    VALUES (${SPINE_IDENTITY_ID}::uuid, ${DEMO_ORGANISATION_ID}::uuid, ${SPINE_PERSON_ID}::uuid, 'email', 'rls-fixture-person@example.com')`;
  await owner.$executeRaw`INSERT INTO pipeline_stages (id, organisation_id, name, position)
    VALUES (${SPINE_STAGE_ID}::uuid, ${DEMO_ORGANISATION_ID}::uuid, 'RLS Fixture Stage', 99)`;
  await owner.$executeRaw`INSERT INTO conversations (id, organisation_id, person_id, person_identity_id, channel)
    VALUES (${SPINE_CONVERSATION_ID}::uuid, ${DEMO_ORGANISATION_ID}::uuid, ${SPINE_PERSON_ID}::uuid, ${SPINE_IDENTITY_ID}::uuid, 'email')`;
  await owner.$executeRaw`INSERT INTO messages (organisation_id, conversation_id, person_id, channel, direction, sender_kind, content_type, body_text, source_table, source_id, occurred_at)
    VALUES (${DEMO_ORGANISATION_ID}::uuid, ${SPINE_CONVERSATION_ID}::uuid, ${SPINE_PERSON_ID}::uuid, 'email', 'inbound', 'person', 'text', 'an rls fixture message', 'inbound_messages', ${randomUUID()}::uuid, now())`;
  await owner.$executeRaw`INSERT INTO activities (organisation_id, person_id, kind, actor_kind, summary)
    VALUES (${DEMO_ORGANISATION_ID}::uuid, ${SPINE_PERSON_ID}::uuid, 'note', 'system', 'an rls fixture note')`;
  await owner.$disconnect();
});

/** Deterministic ids for the spine fixture, so re-runs replace rather than pile up. */
const SPINE_PERSON_ID = "cccccccc-3333-4000-8000-000000000001";
const SPINE_IDENTITY_ID = "cccccccc-3333-4000-8000-000000000002";
const SPINE_STAGE_ID = "cccccccc-3333-4000-8000-000000000003";
const SPINE_CONVERSATION_ID = "cccccccc-3333-4000-8000-000000000004";

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
  // Slice 3.1c-1 — the lead product's first owned table. RLS is the model here
  // (the service-role key is deliberately never used), so a table without a
  // forced policy is one customer's words readable in another customer's mouth.
  "lead_reply_templates",
  // Slice 3.1c-3 — what Eva decided about an enquiry and what she sent. It
  // holds the words a named stranger received, so it needs the boundary most.
  "lead_reply_decisions",
  // Slice 3.3a (migration 0041) — the lead spine. A person's handles and
  // every word they sent, so one customer's people-book must never be
  // readable from another's.
  "people",
  "person_identities",
  "pipeline_stages",
  "conversations",
  "messages",
  "activities",
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
        'organisation_modules', 'leads', 'lead_evidence', 'consent_texts',
        'lead_reply_templates', 'lead_reply_decisions',
        'people', 'person_identities', 'pipeline_stages', 'conversations',
        'messages', 'activities'
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
        'organisation_modules', 'leads', 'lead_evidence', 'consent_texts',
        'lead_reply_templates', 'lead_reply_decisions',
        'people', 'person_identities', 'pipeline_stages', 'conversations',
        'messages', 'activities'
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
    // Slice 3.3a — each has a DEMO-owned control row from beforeAll.
    "people",
    "person_identities",
    "pipeline_stages",
    "conversations",
    "messages",
    "activities",
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
          tx.$executeRaw`INSERT INTO email_accounts (id, organisation_id, module_key, provider, email_address, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, updated_at)
        VALUES (${randomUUID()}::uuid, ${ORG_B}::uuid, 'email_credit_controller', 'microsoft', 'attacker@example.com', 'x', 'x', now(), ARRAY['Mail.Send'], now())`,
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

/**
 * Slice 3.3a — the lead spine (migration 0041).
 *
 * 🚨 THE VIEW IS THE ONE THAT MATTERS. `person_timeline` is a SQL view over
 * `messages` and `activities`, and a view runs with its OWNER's privileges by
 * default — the migrations role, which no tenant policy binds. Without
 * `security_invoker = true` in the migration, `SELECT * FROM person_timeline`
 * as `eva_app` would return every organisation's timeline whatever
 * `app.current_org` says. The three tests below are the proof, with a positive
 * control first so an empty view cannot pass for a guarded one.
 */
describe("RLS: the lead spine and its timeline view (migration 0041)", () => {
  const asDemo = (fn: (tx: PrismaClient) => Promise<unknown>) => asTenant(DEMO_ORGANISATION_ID, fn);

  it("the owning tenant can read its own person's timeline (positive control)", async () => {
    const rows = (await asDemo(
      (tx) =>
        tx.$queryRaw`SELECT item_type FROM person_timeline WHERE person_id = ${SPINE_PERSON_ID}::uuid ORDER BY item_type`,
    )) as { item_type: string }[];
    expect(rows.map((row) => row.item_type)).toEqual(["activity", "message"]);
  });

  it("another tenant reads an EMPTY timeline for that person — the view runs as the caller", async () => {
    const rows = await asTenant(
      ORG_A,
      (tx) =>
        tx.$queryRaw`SELECT item_type FROM person_timeline WHERE person_id = ${SPINE_PERSON_ID}::uuid`,
    );
    expect(rows).toEqual([]);
  });

  it("an unset tenant context reads nothing from the view at all (fails closed)", async () => {
    const rows = await prisma.$transaction(
      (tx) => tx.$queryRaw`SELECT item_type FROM person_timeline`,
    );
    expect(rows).toEqual([]);
  });

  it("the view was created with security_invoker, not merely tested into behaving", async () => {
    // Belt and braces: the behaviour above is the real test, but the option is
    // what a future `CREATE OR REPLACE VIEW` would silently drop.
    const rows = await prisma.$queryRaw<{ reloptions: string[] | null }[]>`
      SELECT reloptions FROM pg_class WHERE relname = 'person_timeline' AND relkind = 'v'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reloptions ?? []).toContain("security_invoker=true");
  });

  it("tenant A cannot INSERT a person carrying tenant B's organisation_id", async () => {
    await expect(
      asTenant(
        ORG_A,
        (tx) =>
          tx.$executeRaw`INSERT INTO people (organisation_id, display_name)
            VALUES (${ORG_B}::uuid, 'PWN')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot INSERT a message into tenant B's thread", async () => {
    await expect(
      asTenant(
        ORG_A,
        (tx) =>
          tx.$executeRaw`INSERT INTO messages (organisation_id, conversation_id, person_id, channel, direction, sender_kind, content_type, source_table, source_id, occurred_at)
            VALUES (${DEMO_ORGANISATION_ID}::uuid, ${SPINE_CONVERSATION_ID}::uuid, ${SPINE_PERSON_ID}::uuid, 'email', 'inbound', 'person', 'text', 'inbound_messages', ${randomUUID()}::uuid, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant A cannot UPDATE tenant B's person or thread", async () => {
    const people = await asTenant(
      ORG_A,
      (tx) =>
        tx.$executeRaw`UPDATE people SET display_name = 'Pwned' WHERE id = ${SPINE_PERSON_ID}::uuid`,
    );
    expect(Number(people)).toBe(0);
    const threads = await asTenant(
      ORG_A,
      (tx) =>
        tx.$executeRaw`UPDATE conversations SET status = 'resolved', resolved_at = now() WHERE id = ${SPINE_CONVERSATION_ID}::uuid`,
    );
    expect(Number(threads)).toBe(0);
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

/**
 * Sessions belong to a PERSON, not to an organisation (migration 0033), so they
 * are the one table here whose policy keys on `app.current_user` rather than
 * `app.current_org`. Which devices a colleague is signed in on is none of your
 * business, even inside the same company — so the attacker in this describe is
 * a legitimate, signed-in member of the SAME organisation.
 */
describe("RLS: one person's sessions are not another's (migration 0033)", () => {
  const USER_A = "aaaaaaaa-1111-4000-8000-0000000000aa";
  const USER_B = "bbbbbbbb-1111-4000-8000-0000000000bb";
  const AUTH_A = "aaaaaaaa-2222-4000-8000-0000000000aa";
  const AUTH_B = "bbbbbbbb-2222-4000-8000-0000000000bb";

  const asUser = async (userId: string, fn: (tx: PrismaClient) => Promise<unknown>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
      return fn(tx as unknown as PrismaClient);
    });

  /** The login path: only the JWT `sub` is known, not the app user id yet. */
  const asAuthIdentity = async (authUserId: string, fn: (tx: PrismaClient) => Promise<unknown>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_auth_user', ${authUserId}, true)`;
      return fn(tx as unknown as PrismaClient);
    });

  beforeAll(async () => {
    const owner = createPrismaClient(TEST_DATABASE_URL);
    for (const [id, email, authId] of [
      [USER_A, "rls.session.a@test.eva.local", AUTH_A],
      [USER_B, "rls.session.b@test.eva.local", AUTH_B],
    ]) {
      // `updated_at` is NOT NULL with no database default — Prisma's @updatedAt
      // is applied by the client, so a raw INSERT has to supply it.
      await owner.$executeRaw`
        INSERT INTO users (id, email, updated_at, auth_user_id)
        VALUES (${id}::uuid, ${email}, now(), ${authId}::uuid)
        ON CONFLICT (id) DO NOTHING`;
    }
    // The row user B must not be able to see. Without it, "B sees nothing"
    // would pass against an empty table whether the policy existed or not.
    await owner.$executeRaw`
      INSERT INTO user_sessions (user_id, session_id, last_seen_at)
      VALUES (${USER_A}::uuid, 'a-private-session', now())
      ON CONFLICT (user_id, session_id) DO NOTHING`;
    await owner.$disconnect();
  });

  it("the owner of the session can see it (positive control)", async () => {
    const rows = await asUser(USER_A, (tx) => tx.userSession.findMany());
    expect((rows as unknown[]).length).toBe(1);
  });

  it("a colleague cannot SELECT somebody else's sessions", async () => {
    const rows = await asUser(USER_B, (tx) => tx.userSession.findMany());
    expect(rows).toEqual([]);
  });

  it("a colleague cannot INSERT a session row in somebody else's name", async () => {
    await expect(
      asUser(USER_B, (tx) =>
        tx.userSession.create({
          data: { userId: USER_A, sessionId: "forged", lastSeenAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  /**
   * ⚠️ THE ATTACK THAT MATTERS MOST: freshening somebody else's stale clock.
   * A stolen session is refused because its stamp is old, so an attacker who
   * could UPDATE that row back to `now()` would walk straight back in.
   */
  it("a colleague cannot UPDATE somebody else's activity stamp", async () => {
    const updated = await asUser(USER_B, (tx) =>
      tx.userSession.updateMany({
        where: { userId: USER_A },
        data: { lastSeenAt: new Date() },
      }),
    );
    expect((updated as { count: number }).count).toBe(0);
  });

  /**
   * ⚠️ AND DELETING ONE IS THE SAME ATTACK WEARING A DIFFERENT HAT. An absent
   * row means "never seen", which is admitted — so deleting a refused session's
   * row would hand it a brand-new clock.
   */
  it("a colleague cannot DELETE somebody else's session row", async () => {
    const deleted = await asUser(USER_B, (tx) =>
      tx.userSession.deleteMany({ where: { userId: USER_A } }),
    );
    expect((deleted as { count: number }).count).toBe(0);
  });

  /**
   * The login-path read (`session_auth_resolution`), which exists so the idle
   * check can collect this session's stamp on the query that resolves the user
   * — instead of opening a second transaction and paying four more round trips
   * on every authenticated request.
   *
   * ⚠️ IT IS ALSO LOAD-BEARING FOR CORRECTNESS, NOT ONLY SPEED. Without it the
   * join returns NULL for every session, NULL means "never seen", and "never
   * seen" is admitted — so the two-day rule would silently stop refusing
   * anybody. Proved by dropping the policy on 2026-08-25: six API tests went
   * red, including the original lock test.
   */
  it("the login path can read its own session stamp with only the auth id", async () => {
    const rows = await asAuthIdentity(AUTH_A, (tx) => tx.userSession.findMany());
    expect((rows as unknown[]).length).toBe(1);
  });

  it("the login path cannot read anybody else's", async () => {
    const rows = await asAuthIdentity(AUTH_B, (tx) => tx.userSession.findMany());
    expect(rows).toEqual([]);
  });

  it("an unset auth context reads nothing at all (fails closed)", async () => {
    const rows = await prisma.$transaction((tx) => tx.userSession.findMany());
    expect(rows).toEqual([]);
  });

  /**
   * ⚠️ THE READ POLICY MUST NOT HAVE BECOME A WRITE ONE. It is `FOR SELECT`
   * precisely so that the cheap login-path context cannot freshen or remove a
   * session row — the two moves that would let a refused session back in.
   */
  it("the login-path context still cannot write a session row", async () => {
    await expect(
      asAuthIdentity(AUTH_A, (tx) =>
        tx.userSession.create({
          data: { userId: USER_A, sessionId: "forged-via-auth", lastSeenAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);

    const updated = await asAuthIdentity(AUTH_A, (tx) =>
      tx.userSession.updateMany({ where: { userId: USER_A }, data: { lastSeenAt: new Date() } }),
    );
    expect((updated as { count: number }).count).toBe(0);
  });
});
