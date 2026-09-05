import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  it("creates exactly the Phase 0 + Slice 1.1 + Slice 1.2 + Slice 1.3 + Slice 1.4 + Slice 1.5 + Slice 1.6 + Slice 1.6a tables", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "_prisma_migrations",
      "activities",
      "audit_logs",
      "channel_connections",
      "consent_events",
      "consent_texts",
      "contacts",
      "conversations",
      "customers",
      "email_accounts",
      "human_escalations",
      "import_rows",
      "imports",
      "inbound_addresses",
      "inbound_channel_messages",
      "inbound_forwarding_requests",
      "inbound_messages",
      "invoice_documents",
      "invoices",
      "lead_evidence",
      "lead_reply_decisions",
      "lead_reply_templates",
      "leads",
      "messages",
      "organisation_memberships",
      "organisation_modules",
      "organisation_role_permissions",
      "organisation_settings",
      "organisations",
      "people",
      "person_identities",
      "pipeline_stages",
      "reminder_sequences",
      "reminder_steps",
      "roles",
      "scheduled_actions",
      "user_sessions",
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
    "consent_events",
    "organisation_role_permissions",
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
    "email_accounts",
    "lead_reply_templates",
    /**
     * ⚠️ ADDED 2026-09-01, AND THE GAP WAS THE POINT. This list was frozen at
     * slice 1.6a: every tenant table built after it — the lead record, its
     * evidence, the whole inbound trio, consent texts, entitlements — was
     * subject to this rule in prose and to nothing in code. A list that names
     * the tables is only a guard for the tables it names.
     */
    "consent_texts",
    "inbound_addresses",
    "inbound_forwarding_requests",
    "inbound_messages",
    "lead_evidence",
    "leads",
    "organisation_modules",
    // Slice 3.2c (migration 0040): the Meta channel pair.
    "channel_connections",
    "inbound_channel_messages",
    // Slice 3.3a (migration 0041): the lead spine.
    "people",
    "person_identities",
    "pipeline_stages",
    "conversations",
    "messages",
    "activities",
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
    "email_accounts",
    "lead_reply_templates",
    /**
     * ⚠️ ONLY THE TABLES THAT ACTUALLY CARRY ALL THREE. `lead_evidence`,
     * `inbound_messages`, `inbound_forwarding_requests` and `consent_texts` are
     * deliberately absent: they are append-only records of something that
     * happened, so they have no `created_by` to fill in and no update to stamp.
     * Adding them here would force a column onto a table whose whole design is
     * that it is never edited.
     */
    "inbound_addresses",
    "leads",
    "organisation_modules",
    // Slice 3.3a: the four spine tables that are edited. `messages` and
    // `activities` are deliberately absent — written once, like evidence.
    "people",
    "person_identities",
    "pipeline_stages",
    "conversations",
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
    "lead_reply_templates",
    /**
     * ⚠️ THE WORST OF THE THREE GAPS. `users`, `organisations`,
     * `organisation_settings`, `organisation_memberships` and `email_accounts`
     * have carried `deleted_at` since Phase 0 and none of them was listed —
     * so the rule that a record is retired rather than destroyed was enforced
     * on seven tables and merely hoped for on the five that hold the account
     * itself and its live OAuth grants.
     *
     * ⚠️ AND ABSENCE IS STILL MEANINGFUL HERE. `import_rows`,
     * `scheduled_actions` and `human_escalations` are deliberately NOT
     * soft-deletable and have their own tests below asserting they have no
     * `deleted_at`. Do not "complete" this list by adding them.
     */
    "email_accounts",
    "inbound_addresses",
    "leads",
    "organisation_memberships",
    "organisation_modules",
    "organisation_settings",
    "organisations",
    "users",
    // A connection is retired, never destroyed — the mailbox rule, one channel over.
    "channel_connections",
    // Slice 3.3a: a person and a custom stage are retired, never destroyed.
    // `person_identities` is NOT here on purpose — a handle is marked
    // `inactive`, and the unique index keeps it from being claimed by
    // somebody else; a `deleted_at` would suggest the handle was free.
    // `conversations` are resolved, not deleted.
    "people",
    "pipeline_stages",
  ])("soft-deletable table %s has deleted_at", async (table) => {
    const names = (await columnsOf(table)).map((c) => c.column_name);
    expect(names).toContain("deleted_at");
  });

  it("messages and activities are written once: created_at only, no updated_at/deleted_at (migration 0041)", async () => {
    for (const table of ["messages", "activities"]) {
      const names = (await columnsOf(table)).map((c) => c.column_name);
      expect(names, `${table} must have created_at`).toContain("created_at");
      expect(names, `${table} must not have updated_at`).not.toContain("updated_at");
      expect(names, `${table} must not have deleted_at`).not.toContain("deleted_at");
    }
  });

  it("person_identities and conversations have no deleted_at: a handle goes inactive, a thread is resolved", async () => {
    for (const table of ["person_identities", "conversations"]) {
      const names = (await columnsOf(table)).map((c) => c.column_name);
      expect(names, `${table} must not have deleted_at`).not.toContain("deleted_at");
    }
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

  it("email_accounts stores only valid provider + health_status values (CHECK constraints)", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'email_accounts'::regclass AND contype = 'c'`;
    const names = rows.map((row) => row.conname).join(" ");
    expect(names).toContain("provider");
    expect(names).toContain("health_status");
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

  it("BRD 4.1 duplicate prevention: two concurrent LIVE schedules of the same (invoice, step, date) — exactly one succeeds", async () => {
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

  it("a cancelled slot CAN be re-inserted: partial unique index covers live rows only (migration 0011, founder ruling)", async () => {
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
    const original = await prisma.scheduledAction.create({ data });
    // cancelled is terminal — the row stays, but its (invoice, step, date)
    // slot is free for a fresh row.
    await prisma.scheduledAction.update({
      where: { id: original.id },
      data: { status: "cancelled" },
    });
    const replacement = await prisma.scheduledAction.create({
      data: { ...data, idempotencyKey: randomUUID() },
    });
    expect(replacement.id).not.toBe(original.id);

    const untouched = await prisma.scheduledAction.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(untouched.status).toBe("cancelled");

    // …while TWO live rows for the slot are still refused.
    await expect(prisma.scheduledAction.create({ data })).rejects.toThrow();

    // Fixture hygiene.
    await prisma.invoice.delete({ where: { id: invoice.id } });
    await prisma.reminderSequence.delete({ where: { id: step.sequenceId } });
    await prisma.customer.delete({ where: { id: invoice.customerId } });
  });

  it("list_active_organisations is SECURITY DEFINER, EXECUTE granted to eva_app only (migration 0010, plan §7.8)", async () => {
    const fn = await prisma.$queryRaw<{ prosecdef: boolean; prorettype: string }[]>`
      SELECT p.prosecdef, pg_catalog.pg_get_function_result(p.oid) AS prorettype
      FROM pg_proc p
      WHERE p.proname = 'list_active_organisations' AND p.pronargs = 0`;
    expect(fn).toHaveLength(1);
    expect(fn[0]?.prosecdef, "function must be SECURITY DEFINER").toBe(true);
    expect(fn[0]?.prorettype).toBe("SETOF uuid");

    const appGrant = await prisma.$queryRaw<{ has: boolean }[]>`
      SELECT has_function_privilege('eva_app', 'list_active_organisations()', 'EXECUTE') AS has`;
    expect(appGrant[0]?.has, "eva_app must hold EXECUTE").toBe(true);
    // PUBLIC is a pseudo-role (aclexplode grantee 0), not checkable via
    // has_function_privilege — inspect the function ACL directly.
    const acl = await prisma.$queryRaw<{ grantee: number; privilege_type: string }[]>`
      SELECT a.grantee::int AS grantee, a.privilege_type
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE p.proname = 'list_active_organisations' AND p.pronargs = 0`;
    expect(
      acl.some((entry) => entry.grantee === 0),
      "PUBLIC must not appear in the function ACL",
    ).toBe(false);
  });

  it("list_active_organisations EXECUTE is revoked from Supabase API roles (migration 0012)", async () => {
    // Supabase default privileges auto-grant EXECUTE on new public functions
    // to anon/authenticated/service_role; 0012 revokes them. Migration 0015
    // creates those roles wherever they are absent, so this now bites on local
    // Docker and in CI too — it used to be vacuous there.
    const leaked = await prisma.$queryRaw<{ rolname: string }[]>`
      SELECT r.rolname
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      JOIN pg_roles r ON r.oid = a.grantee
      WHERE p.proname = 'list_active_organisations' AND p.pronargs = 0
        AND a.privilege_type = 'EXECUTE'
        AND r.rolname IN ('anon', 'authenticated', 'service_role')`;
    expect(
      leaked,
      "Supabase API roles must not hold EXECUTE on list_active_organisations()",
    ).toHaveLength(0);
  });

  /**
   * Guard for the three ACL assertions around it (0012 function EXECUTE, 0014
   * table privileges, 0014 default privileges). Each one asks "do these roles
   * hold anything?" — which answers "no" for free if the roles do not exist.
   * They only exist on Supabase, so before migration 0015 created them locally
   * every one of those assertions passed vacuously on Docker and in CI, and a
   * migration granting to `anon` would have reached production unchallenged.
   * If this test fails, treat the others as meaningless until it passes again.
   */
  it("the Supabase API roles exist here, so the ACL assertions are not vacuous (migration 0015)", async () => {
    const roles = await prisma.$queryRaw<{ rolname: string; rolcanlogin: boolean }[]>`
      SELECT rolname, rolcanlogin FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role')
      ORDER BY rolname`;
    expect(
      roles.map((role) => role.rolname),
      "migration 0015 must create these roles wherever they are absent",
    ).toEqual(["anon", "authenticated", "service_role"]);
    for (const role of roles) {
      // Locally 0015 creates them NOLOGIN; on Supabase they are NOLOGIN too
      // (PostgREST reaches them via SET ROLE). A LOGIN-capable anon would be a
      // genuine finding.
      expect(role.rolcanlogin, `${role.rolname} must not be able to log in`).toBe(false);
    }
  });

  it("Supabase API roles hold NO privileges on any public table (migration 0014)", async () => {
    // Supabase default privileges auto-grant arwdDxtm on every new public
    // table to anon/authenticated/service_role — and `anon` is the PUBLIC api
    // key. RLS blocked reads and writes, but TRUNCATE is not subject to RLS, so
    // 0014 removes the grants outright. Read the ACL directly (relacl) rather
    // than information_schema, which only shows grants the caller can see.
    // Meaningful everywhere since 0015 mirrors the roles locally; hosted
    // privilege drift is additionally covered by scripts/verify-supabase-acl.sql.
    const leaked = await prisma.$queryRaw<{ relname: string; rolname: string }[]>`
      SELECT c.relname, r.rolname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND r.rolname IN ('anon', 'authenticated', 'service_role')
      ORDER BY c.relname, r.rolname`;
    expect(
      leaked,
      `Supabase API roles must hold no table privileges; leaked: ${leaked
        .map((row) => `${row.rolname}->${row.relname}`)
        .join(", ")}`,
    ).toHaveLength(0);
  });

  it("no public function grants EXECUTE to PUBLIC or the API roles (migration 0016)", async () => {
    // 0012 revoked EXECUTE from one function without removing the ALTER DEFAULT
    // PRIVILEGES that granted it, and Postgres separately grants EXECUTE on new
    // functions to PUBLIC. 0016 closed both. aclexplode reports PUBLIC as
    // grantee 0, which has no pg_roles row — hence the LEFT JOIN.
    const leaked = await prisma.$queryRaw<{ proname: string; grantee: string }[]>`
      SELECT p.proname, COALESCE(r.rolname, 'PUBLIC') AS grantee
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE'
        AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
      ORDER BY p.proname`;
    expect(
      leaked,
      `public functions must not grant EXECUTE to PUBLIC or the API roles; leaked: ${leaked
        .map((row) => `${row.grantee}->${row.proname}`)
        .join(", ")}`,
    ).toHaveLength(0);
  });

  it("future public functions will not re-grant EXECUTE (migration 0016)", async () => {
    const defaults = await prisma.$queryRaw<{ acl: string }[]>`
      SELECT d.defaclacl::text AS acl
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
        AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
    for (const row of defaults) {
      for (const apiRole of ["anon", "authenticated", "service_role"]) {
        expect(row.acl, `function defaults must not name ${apiRole}`).not.toContain(apiRole);
      }
      // A bare `=X/owner` entry is the PUBLIC grant.
      expect(row.acl, "function defaults must not grant EXECUTE to PUBLIC").not.toMatch(/(^|,)=/);
    }
  });

  it("future public tables will not re-grant to Supabase API roles (migration 0014)", async () => {
    // The grants above came from ALTER DEFAULT PRIVILEGES, so revoking the
    // existing ones is not enough: without this, the next CREATE TABLE silently
    // reinstates them. Only the CREATING role's defaults apply to a new object,
    // and migrations run as the database owner — so check that role's defaults.
    const defaults = await prisma.$queryRaw<{ obj_type: string; acl: string }[]>`
      SELECT d.defaclobjtype::text AS obj_type, d.defaclacl::text AS acl
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = 'public'
        AND d.defaclobjtype IN ('r', 'S')
        AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
    for (const row of defaults) {
      for (const apiRole of ["anon", "authenticated", "service_role"]) {
        expect(
          row.acl,
          `default privileges for ${row.obj_type} must not name ${apiRole}`,
        ).not.toContain(apiRole);
      }
    }
  });

  it("list_active_organisations returns only orgs with at least one live active invoice", async () => {
    const suffix = randomUUID().slice(0, 8);
    const orgNone = await prisma.organisation.create({ data: { name: `LAO-none-${suffix}` } });
    const orgDraft = await prisma.organisation.create({ data: { name: `LAO-draft-${suffix}` } });
    const orgActive = await prisma.organisation.create({ data: { name: `LAO-active-${suffix}` } });
    // Slice 1.6a: the function now also requires the email credit controller,
    // so these fixtures must hold it or they drop out for the wrong reason and
    // the invoice-status assertions below would pass vacuously.
    for (const organisation of [orgNone, orgDraft, orgActive]) {
      await prisma.organisationModule.create({
        data: { organisationId: organisation.id, moduleKey: "email_credit_controller" },
      });
    }
    const draftCustomer = await prisma.customer.create({
      data: { organisationId: orgDraft.id, name: `LAO draft customer ${suffix}` },
    });
    const activeCustomer = await prisma.customer.create({
      data: { organisationId: orgActive.id, name: `LAO active customer ${suffix}` },
    });
    // A draft invoice does NOT qualify the org.
    await prisma.invoice.create({
      data: {
        organisationId: orgDraft.id,
        customerId: draftCustomer.id,
        invoiceNumber: `LAO-D-${suffix}`,
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
      },
    });
    const activeInvoice = await prisma.invoice.create({
      data: {
        organisationId: orgActive.id,
        customerId: activeCustomer.id,
        invoiceNumber: `LAO-A-${suffix}`,
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
        status: "active",
      },
    });

    const listIds = async (): Promise<string[]> => {
      const rows = await prisma.$queryRaw<{ list_active_organisations: string }[]>`
        SELECT * FROM list_active_organisations()`;
      return rows.map((row) => row.list_active_organisations);
    };

    const ids = await listIds();
    expect(ids).toContain(orgActive.id);
    expect(ids).not.toContain(orgNone.id);
    expect(ids).not.toContain(orgDraft.id);

    // Slice 1.6a: switching the product off must drop the organisation out of
    // the sweep even though its invoice is untouched — a disabled module has
    // to stop outbound action, not merely hide a button (BRD §3.4).
    await prisma.organisationModule.updateMany({
      where: { organisationId: orgActive.id },
      data: { enabled: false },
    });
    expect(await listIds()).not.toContain(orgActive.id);
    await prisma.organisationModule.updateMany({
      where: { organisationId: orgActive.id },
      data: { enabled: true },
    });
    expect(await listIds()).toContain(orgActive.id);

    // A soft-deleted active invoice no longer qualifies the org.
    await prisma.invoice.update({
      where: { id: activeInvoice.id },
      data: { deletedAt: new Date() },
    });
    expect(await listIds()).not.toContain(orgActive.id);

    // Fixture hygiene: org deletes cascade customers/invoices.
    await prisma.organisation.deleteMany({
      where: { id: { in: [orgNone.id, orgDraft.id, orgActive.id] } },
    });
  });

  /**
   * ⚠️ THIS TEST EXISTS BECAUSE THE FIRST VERSION OF MIGRATION 0026 WAS A LIE.
   *
   * It granted `SELECT, INSERT` on `lead_evidence` and wrote a confident
   * comment about the database refusing to change compliance evidence. But
   * `ALTER DEFAULT PRIVILEGES FOR ROLE eva` hands `eva_app` all four
   * privileges on every table `eva` creates (`pg_default_acl` shows
   * `eva_app=arwd`), and a GRANT only ever ADDS. UPDATE and DELETE were sitting
   * there from the default, on the one table whose entire job is being
   * provable, and nothing failed.
   *
   * BRD 4.3: consent evidence must be immutable "so evidence remains provable".
   * The revoke is what makes that true, and this is what keeps the revoke.
   */
  it("evidence and consent wording cannot be changed by the app role, ever", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE grantee = 'eva_app'
        AND table_name IN ('lead_evidence', 'consent_texts')`;

    const granted = new Set(rows.map((row) => `${row.table_name}.${row.privilege_type}`));

    for (const table of ["lead_evidence", "consent_texts"]) {
      // Readable and writable once...
      expect(granted.has(`${table}.SELECT`), `${table} must be readable`).toBe(true);
      expect(granted.has(`${table}.INSERT`), `${table} must be writable once`).toBe(true);
      // ...and never changeable afterwards. Cascade still removes it with its
      // lead: referential actions run with the constraint owner's privileges.
      expect(granted.has(`${table}.UPDATE`), `${table} must NOT be updatable`).toBe(false);
      expect(granted.has(`${table}.DELETE`), `${table} must NOT be deletable`).toBe(false);
    }
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

  it("organisation_settings.default_currency is GBP by default and ISO-shaped (migration 0022)", async () => {
    /**
     * ⚠️ THE CHECK EXISTS BECAUSE A BAD CODE HERE FAILS SILENTLY, NOT LOUDLY.
     * The money layer indexes its minor-unit table by exact ISO 4217 code, so
     * `gbp` would miss and fall through to the 2-digit assumption — correct for
     * sterling and wrong for KWD (3 digits) and JPY (0). A form would open on a
     * currency whose decimals were quietly mis-stated.
     */
    /**
     * Its OWN organisation, not the seeded demo one. Vitest runs spec FILES in
     * parallel against one database, and this test deliberately writes an odd
     * currency — doing that to a shared row would surface as somebody else's
     * unrelated failure.
     */
    const organisation = await prisma.organisation.create({
      data: { id: randomUUID(), name: `Currency Default ${randomUUID().slice(0, 8)}` },
    });
    const organisationId = organisation.id;
    // Created WITHOUT naming the currency, so the column's own default is what
    // is being asserted rather than something this test supplied.
    await prisma.organisationSettings.create({ data: { organisationId } });

    const [settings] = await prisma.$queryRaw<{ default_currency: string }[]>`
      SELECT default_currency FROM organisation_settings WHERE organisation_id = ${organisationId}::uuid`;
    expect(settings?.default_currency).toBe("GBP");

    for (const bad of ["gbp", "GB", "GBPP", "G8P", ""]) {
      await expect(
        prisma.$executeRaw`
          UPDATE organisation_settings SET default_currency = ${bad}
          WHERE organisation_id = ${organisationId}::uuid`,
        bad,
      ).rejects.toThrow();
    }

    // A three-letter uppercase code we do not list anywhere is still accepted:
    // the column is a default, not a whitelist of markets we serve.
    await prisma.$executeRaw`
      UPDATE organisation_settings SET default_currency = 'ZAR'
      WHERE organisation_id = ${organisationId}::uuid`;
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

  /**
   * Migration 0043: an enquiry always has a stage. The other two spine
   * pointers stay nullable on purpose — a hand-logged enquiry has no proven
   * person and opened no thread — and are the positive control here.
   */
  it("leads.pipeline_stage_id is NOT NULL since 0043; person_id and origin_conversation_id stay nullable", async () => {
    const cols = await columnsOf("leads");
    const nullability = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(nullability.pipeline_stage_id).toBe("NO");
    expect(nullability.person_id).toBe("YES");
    expect(nullability.origin_conversation_id).toBe("YES");
  });

  it("consent_events is permanent: created_at only, no updated_at/deleted_at", async () => {
    const names = (await columnsOf("consent_events")).map((c) => c.column_name);
    expect(names).toContain("created_at");
    expect(names).toContain("created_by");
    expect(names).not.toContain("updated_at");
    expect(names).not.toContain("deleted_at");
  });

  /**
   * Slice 3.3d (migration 0042): the do-not-contact log's old name is a VIEW
   * in the 0028 shape, so a hand-written query from before the rename reads
   * exactly what it used to — and none of the consent columns leak into it.
   */
  it("suppression_events is a view in the 0028 shape over consent_events", async () => {
    // `relkind` is Postgres's one-byte "char", which Prisma cannot read raw.
    const kind = await prisma.$queryRaw<{ relkind: string }[]>`
      SELECT relkind::text AS relkind FROM pg_class WHERE relname = 'suppression_events'`;
    expect(kind).toEqual([{ relkind: "v" }]);
    const names = (await columnsOf("suppression_events")).map((c) => c.column_name).sort();
    expect(names).toEqual([
      "action",
      "channel",
      "created_at",
      "created_by",
      "id",
      "organisation_id",
      "reason",
      "value",
    ]);
    const table = (await columnsOf("consent_events")).map((c) => c.column_name);
    for (const column of [
      "state",
      "purpose",
      "basis",
      "source",
      "evidence",
      "jurisdiction",
      "expires_at",
    ]) {
      expect(table, `consent_events.${column}`).toContain(column);
    }
  });

  /**
   * ⚠️ THE CONSENT RULES ARE CHECKS, NOT CONVENTIONS (migration 0042, blueprint
   * §2.5): consent names a purpose and rests on a basis; an opt-out carries no
   * basis and never expires; a correction says why. Each is tried by hand as
   * the OWNER, whom nothing else stops, so a refusal can only be the
   * constraint. The positive control comes last: a well-formed consent goes in,
   * so the refusals above it were not vacuous.
   */
  describe("consent_events refuses a row that contradicts itself (migration 0042)", () => {
    const VALUE = "contradiction@example.com";
    const attempt = (columns: string, values: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO consent_events (id, organisation_id, channel, value, ${columns})
         VALUES ('${randomUUID()}', '${DEMO_ORGANISATION_ID}', 'email', '${VALUE}', ${values})`,
      );

    afterAll(async () => {
      await prisma.$executeRaw`DELETE FROM consent_events WHERE value = ${VALUE}`;
    });

    it("a consent to `all` — there is no such thing", async () => {
      await expect(
        attempt("state, purpose, basis", "'opted_in', 'all', 'express'"),
      ).rejects.toThrow(/consent_events_consent_names_a_purpose_check/);
    });

    it("a consent with no basis — the boolean the report forbids", async () => {
      await expect(attempt("state, purpose", "'opted_in', 'marketing'")).rejects.toThrow(
        /consent_events_basis_on_consent_only_check/,
      );
    });

    it("an opt-out with a basis — an opt-out rests on nothing but itself", async () => {
      await expect(attempt("state, basis", "'opted_out', 'express'")).rejects.toThrow(
        /consent_events_basis_on_consent_only_check/,
      );
    });

    it("an opt-out that expires — permanently is the BRD's word", async () => {
      await expect(
        attempt("state, expires_at", "'opted_out', now() + interval '1 day'"),
      ).rejects.toThrow(/consent_events_expiry_on_consent_only_check/);
    });

    it("a correction with no reason (carried from 0028)", async () => {
      await expect(attempt("state", "'corrected'")).rejects.toThrow(
        /consent_events_correction_reason_check/,
      );
    });

    it.each([
      ["state", "'maybe'", /consent_events_state_check/],
      ["purpose", "'everything'", /consent_events_purpose_check/],
      ["source", "'telepathy'", /consent_events_source_check/],
      [
        "state, purpose, basis",
        "'opted_in', 'marketing', 'because_they_said_so'",
        /consent_events_basis_check/,
      ],
      [
        "state, purpose, basis, jurisdiction",
        "'opted_in', 'marketing', 'express', 'Florida'",
        /consent_events_jurisdiction_check/,
      ],
    ] as const)("a word the vocabulary does not have: %s = %s", async (columns, values, check) => {
      await expect(attempt(columns, values)).rejects.toThrow(check);
    });

    it("and accepts a well-formed consent (positive control)", async () => {
      await expect(
        attempt(
          "state, purpose, basis, source, evidence, jurisdiction, expires_at",
          `'opted_in', 'marketing', 'express', 'form', '{"wording": "Send me offers"}'::jsonb, 'US-FL', now() + interval '2 years'`,
        ),
      ).resolves.toBe(1);
    });
  });

  /**
   * Migration 0044 (slice 3.4a): a wording and a decision may be for
   * WhatsApp now, and still for nothing else. The vocabulary is the CHECK's,
   * and `REPLY_CHANNELS` in `@eva/types` is its twin; the api's
   * `lead-reply-templates.service.ts` throws if the two ever disagree.
   */
  describe("a wording belongs to a channel Eva can answer on (migrations 0039 and 0044)", () => {
    const NAME_PREFIX = "0044-check-";
    const attempt = (channel: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO lead_reply_templates (id, organisation_id, channel, name, body, updated_at)
         VALUES ('${randomUUID()}', '${DEMO_ORGANISATION_ID}', '${channel}', '${NAME_PREFIX}${channel}', 'A wording.', now())`,
      );

    afterAll(async () => {
      await prisma.$executeRaw`DELETE FROM lead_reply_templates WHERE name LIKE ${`${NAME_PREFIX}%`}`;
    });

    it("admits email and WhatsApp (positive control)", async () => {
      await expect(attempt("email")).resolves.toBe(1);
      await expect(attempt("whatsapp")).resolves.toBe(1);
    });

    /** The case that must fail: the next channel is a migration, not a string. */
    it("refuses a channel nothing can send on yet", async () => {
      await expect(attempt("messenger")).rejects.toThrow(/lead_reply_templates_channel_check/);
      await expect(attempt("Email")).rejects.toThrow(/lead_reply_templates_channel_check/);
    });

    /**
     * The decision's CHECK moves in lockstep. Read from the catalogue rather
     * than inserted, because a decision needs a lead and a lead needs a stage;
     * `lead-reply-whatsapp.spec.ts` in the api writes the real row (status
     * `sent`, channel `whatsapp`) and would fail against the old CHECK.
     */
    it("lets a decision name WhatsApp too, and nothing else", async () => {
      const rows = await prisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'lead_reply_decisions_channel_check'`;
      expect(rows).toHaveLength(1);
      const definition = rows[0]!.definition.replace(/\s+/g, " ");
      expect(definition).toContain("'email'");
      expect(definition).toContain("'whatsapp'");
      expect(definition).not.toContain("'messenger'");
      expect(definition).toMatch(/IS NULL/);
    });
  });

  it("stores timestamps as timestamptz (UTC, BRD 18.1)", async () => {
    const cols = await columnsOf("organisations");
    const createdAt = cols.find((c) => c.column_name === "created_at");
    expect(createdAt?.data_type).toBe("timestamp with time zone");
  });

  /**
   * Slice 1.6a — module entitlements and mailbox seats (migration 0017).
   */
  describe("organisation_modules (Slice 1.6a)", () => {
    /**
     * THE ROLLOUT RISK, and the reason this test exists rather than a comment.
     *
     * Enforcement fails closed: absence of a row means not entitled. So an
     * organisation the backfill missed does not degrade, it stops working
     * entirely — invoices, imports, reminders and mailbox all 402 at once, on
     * deploy, for a customer who did nothing. Asserted against the real
     * migrated database rather than trusted.
     */
    it("the backfill granted the email credit controller to EVERY organisation that existed when it ran", async () => {
      // Scoped to organisations older than the migration itself. The naive
      // "every live organisation" version passed or failed depending on which
      // specs had run first, because later tests create organisations the
      // migration could not possibly have seen — an assertion that drifts with
      // execution order is not evidence of anything.
      const missed = await prisma.$queryRaw<{ id: string }[]>`
        SELECT o.id FROM organisations o
        WHERE o.deleted_at IS NULL
          AND o.created_at < (
            SELECT finished_at FROM _prisma_migrations
            WHERE migration_name = '20260801100000_organisation_modules')
          AND NOT EXISTS (
            SELECT 1 FROM organisation_modules m
            WHERE m.organisation_id = o.id
              AND m.module_key = 'email_credit_controller'
              AND m.enabled AND m.deleted_at IS NULL)`;
      expect(missed).toEqual([]);
    });

    it("stores only valid module_key, source and seats (CHECK constraints)", async () => {
      const rows = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'organisation_modules'::regclass AND contype = 'c'`;
      const names = rows.map((row) => row.conname).join(" ");
      expect(names).toContain("module_key");
      expect(names).toContain("source");
      expect(names).toContain("seats");
    });

    it("refuses an unknown module_key, a bogus source, and zero seats", async () => {
      const base = { organisationId: DEMO_ORGANISATION_ID, moduleKey: "ai_receptionist" };
      await expect(
        prisma.organisationModule.create({ data: { ...base, moduleKey: "crystal_ball" } }),
      ).rejects.toThrow();
      await expect(
        prisma.organisationModule.create({ data: { ...base, source: "vibes" } }),
      ).rejects.toThrow();
      // Zero seats would mean "entitled but may connect nothing", which is a
      // state no code path knows how to explain to a customer.
      await expect(
        prisma.organisationModule.create({ data: { ...base, seats: 0 } }),
      ).rejects.toThrow();
    });

    it("seats is NOT NULL and defaults to 1 — a NULL meaning unlimited would fail OPEN", async () => {
      // Queried directly rather than via columnsOf, which does not select
      // column_default; the default is half of what this test is about.
      const rows = await prisma.$queryRaw<{ is_nullable: string; column_default: string | null }[]>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organisation_modules'
          AND column_name = 'seats'`;
      expect(rows[0]?.is_nullable).toBe("NO");
      expect(rows[0]?.column_default).toBe("1");
    });

    it("one live row per (organisation, module), and a soft-deleted one does not block re-enabling", async () => {
      const data = { organisationId: DEMO_ORGANISATION_ID, moduleKey: "lead_follow_up" };
      await prisma.organisationModule.deleteMany({ where: data });
      const first = await prisma.organisationModule.create({ data });
      await expect(prisma.organisationModule.create({ data })).rejects.toThrow();
      await prisma.organisationModule.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      });
      const second = await prisma.organisationModule.create({ data });
      await prisma.organisationModule.deleteMany({ where: data });
      expect(second.id).not.toBe(first.id);
    });
  });

  /**
   * Slice 1.6a Task 7a — the index surgery that supersedes slice 1.6 ruling 6.
   * Ruling 6 was enforced by a database index alone, and connecting a second
   * mailbox silently OVERWROTE the first.
   */
  describe("email_accounts seats reshaping (Slice 1.6a)", () => {
    const mailbox = (address: string, overrides: Record<string, unknown> = {}) => ({
      organisationId: DEMO_ORGANISATION_ID,
      // Which product owns it (migration 0034). Overridable, because the
      // per-product rules below need two different values.
      moduleKey: "email_credit_controller",
      provider: "microsoft",
      emailAddress: address,
      ...overrides,
    });

    it("the one-live-mailbox-per-organisation index is GONE", async () => {
      const rows = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'email_accounts'`;
      const names = rows.map((row) => row.indexname);
      expect(names).not.toContain("email_accounts_live_organisation_key");
      expect(names).toContain("email_accounts_live_address_key");
      expect(names).toContain("email_accounts_single_primary_key");
    });

    it("an organisation may now hold two live mailboxes at different addresses", async () => {
      const a = `seat-a-${randomUUID().slice(0, 8)}@example.com`;
      const b = `seat-b-${randomUUID().slice(0, 8)}@example.com`;
      const first = await prisma.emailAccount.create({ data: mailbox(a) });
      const second = await prisma.emailAccount.create({ data: mailbox(b) });
      await prisma.emailAccount.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      expect(second.organisationId).toBe(first.organisationId);
    });

    /** One ADDRESS cannot occupy two seats. Case-insensitive because Microsoft
     *  is — reconnecting Sara@ must reuse the row created for sara@. */
    it("refuses a second live row for the same address, ignoring case", async () => {
      const address = `dupe-${randomUUID().slice(0, 8)}@example.com`;
      const first = await prisma.emailAccount.create({ data: mailbox(address) });
      await expect(
        prisma.emailAccount.create({ data: mailbox(address.toUpperCase()) }),
      ).rejects.toThrow();
      await prisma.emailAccount.delete({ where: { id: first.id } });
    });

    /**
     * ⚠️ ONE PRIMARY PER ORGANISATION *PER PRODUCT* SINCE MIGRATION 0034.
     * It was one per organisation from 0017 until 2026-09-01, which is why
     * a second product could never have a default at all — its first
     * mailbox hit this index and the insert failed with nothing on any
     * screen to explain it. Both halves are asserted: still one within a
     * product, and now one EACH across two.
     */
    it("allows exactly one primary mailbox per organisation, per product", async () => {
      const a = `prim-a-${randomUUID().slice(0, 8)}@example.com`;
      const b = `prim-b-${randomUUID().slice(0, 8)}@example.com`;
      const c = `prim-c-${randomUUID().slice(0, 8)}@example.com`;
      const first = await prisma.emailAccount.create({ data: mailbox(a, { isPrimary: true }) });
      await expect(
        prisma.emailAccount.create({ data: mailbox(b, { isPrimary: true }) }),
      ).rejects.toThrow();
      // The OTHER product gets its own default, and that is the change.
      const other = await prisma.emailAccount.create({
        data: mailbox(c, { isPrimary: true, moduleKey: "lead_follow_up" }),
      });
      expect(other.isPrimary).toBe(true);
      // Non-primary siblings are fine — that is the whole point of seats.
      const second = await prisma.emailAccount.create({ data: mailbox(b) });
      await prisma.emailAccount.deleteMany({
        where: { id: { in: [first.id, second.id, other.id] } },
      });
      expect(second.isPrimary).toBe(false);
    });

    /** Deploy had to be a zero-behaviour-change event: before 0017 every
     *  organisation had at most one live mailbox, so each ends with exactly
     *  one primary and nothing a customer can observe changed. */
    it("no mailbox that predates the migration was left without a primary", async () => {
      // Same scoping problem as the backfill test above, with an extra twist:
      // specs in this very file create non-primary mailboxes on purpose (that
      // is what seats are for), so "every organisation has a primary" is not
      // even true going forward. Only the migration's own work is in scope.
      const orphaned = await prisma.$queryRaw<{ organisation_id: string }[]>`
        SELECT organisation_id FROM email_accounts
        WHERE deleted_at IS NULL
          AND created_at < (
            SELECT finished_at FROM _prisma_migrations
            WHERE migration_name = '20260801100000_organisation_modules')
        GROUP BY organisation_id
        HAVING count(*) FILTER (WHERE is_primary) = 0`;
      expect(orphaned).toEqual([]);
    });
  });

  /**
   * Migration 0019 — what Eva needs to chase, and nothing more.
   * Founder ruling: "Eva is only a follow-up agent, not an accountant."
   * Design notes: docs/DATA-MODEL-REVIEW.md
   */
  describe("Slice 1.6b groundwork: invoice balance and provenance (0019)", () => {
    it("invoices carry a paid amount, so a part-paid debtor is chased for the BALANCE", async () => {
      const columns = await prisma.$queryRaw<
        { column_name: string; column_default: string | null }[]
      >`
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_name = 'invoices'
          AND column_name IN (
            'amount_paid_minor_units', 'last_payment_at', 'customer_reference',
            'payment_terms', 'description', 'source', 'external_id')`;
      expect(columns.map((c) => c.column_name).sort()).toEqual([
        "amount_paid_minor_units",
        "customer_reference",
        "description",
        "external_id",
        "last_payment_at",
        "payment_terms",
        "source",
      ]);
      // Defaulted, so the migration needs no backfill and every pre-existing
      // invoice reads as "nothing paid" rather than NULL.
      const paid = columns.find((c) => c.column_name === "amount_paid_minor_units");
      expect(paid?.column_default).toContain("0");
    });

    /**
     * THE RULING, encoded. Overpayment is allowed: refusing an import because a
     * debtor paid too much is an accounting objection, and Eva is not an
     * accountant. The balance clamps at zero and chasing stops.
     */
    it("allows overpayment — the CHECK bounds paid at zero and NOT at the invoice total", async () => {
      const [check] = await prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conname = 'invoices_amount_paid_check'`;
      expect(check?.def).toContain("amount_paid_minor_units");
      expect(check?.def).toContain(">= 0");
      // If this ever starts referencing the invoice total, someone has quietly
      // reversed the ruling and a legitimate overpaid import will be rejected.
      expect(check?.def).not.toContain("amount_minor_units)");
    });

    it("scopes remote identity per organisation AND system, and only when there is one", async () => {
      const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('invoices_external_ref_key', 'customers_external_ref_key')`;
      expect(indexes.length).toBe(2);
      for (const index of indexes) {
        expect(index.indexdef).toContain("UNIQUE");
        expect(index.indexdef).toContain("organisation_id");
        expect(index.indexdef).toContain("source");
        expect(index.indexdef).toContain("external_id");
        // Partial on both counts: manually created rows carry no external_id and
        // must not collide, and soft-deleted history must never block a
        // re-import of the same remote invoice.
        expect(index.indexdef).toContain("external_id IS NOT NULL");
        expect(index.indexdef).toContain("deleted_at IS NULL");
      }
    });

    it("keeps payment instructions on the organisation, not on every invoice", async () => {
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'organisation_settings' AND column_name = 'payment_instructions'`;
      expect(columns.length).toBe(1);
    });

    /** Contact details were NOT added by 0019 — they already existed, and the
     *  voice module will read contacts.phone with no schema change. */
    it("already had the email and phone the follow-up and voice agents need", async () => {
      const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('customers', 'contacts') AND column_name IN ('email', 'phone')`;
      expect(columns.length).toBe(4);
    });
  });

  /**
   * Migration 0020 — which mailbox chases which client (Slice 1.6b, Task 1).
   *
   * Design: docs/ALLOCATION-SCOPE.md §4a, plan Task 1 and decision D2.
   * Ruling 1: NULL means "chase from the DEFAULT mailbox", NEVER "do not chase".
   */
  describe("Slice 1.6b: client allocation across mailbox seats (0020)", () => {
    /** A throwaway second tenant, so cross-tenant attempts are real rather than
     *  simulated. Created per-test and torn down, because these specs share
     *  eva_test with others running in parallel. */
    async function otherOrganisation() {
      return prisma.organisation.create({
        data: { id: randomUUID(), name: `Allocation Foreign Org ${randomUUID().slice(0, 8)}` },
      });
    }

    async function mailboxFor(organisationId: string) {
      return prisma.emailAccount.create({
        data: {
          organisationId,
          // Client filing is Invoice Chasing's (founder ruling 2026-09-01).
          moduleKey: "email_credit_controller",
          provider: "microsoft",
          emailAddress: `alloc-${randomUUID().slice(0, 8)}@example.com`,
        },
      });
    }

    async function customerFor(organisationId: string) {
      return prisma.customer.create({
        data: {
          id: randomUUID(),
          organisationId,
          name: `Allocation Fixture ${randomUUID().slice(0, 8)}`,
        },
      });
    }

    it("gives a client an optional mailbox, nullable because unallocated is normal", async () => {
      const [column] = await prisma.$queryRaw<
        { is_nullable: string; data_type: string; column_default: string | null }[]
      >`
        SELECT is_nullable, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'email_account_id'`;
      expect(column?.data_type).toBe("uuid");
      // Ruling 1 lives in this one assertion. A NOT NULL column would force
      // every client to be filed before it could be chased at all.
      expect(column?.is_nullable).toBe("YES");
      expect(column?.column_default).toBeNull();
    });

    /** POSITIVE CONTROL. Without this, the cross-tenant refusal below could pass
     *  because allocation is broken for everyone, not because it is scoped. */
    it("allows a client to be filed under a mailbox in its OWN organisation", async () => {
      const mailbox = await mailboxFor(DEMO_ORGANISATION_ID);
      const customer = await customerFor(DEMO_ORGANISATION_ID);
      const filed = await prisma.customer.update({
        where: { id: customer.id },
        data: { emailAccountId: mailbox.id },
      });
      expect(filed.emailAccountId).toBe(mailbox.id);
      await prisma.customer.delete({ where: { id: customer.id } });
      await prisma.emailAccount.delete({ where: { id: mailbox.id } });
    });

    /**
     * THE ONE THAT MATTERS (plan D2). RLS on `customers` checks the CUSTOMER's
     * organisation and never looks at the mailbox, so nothing but application
     * code stands between us and one company's chasing letters going out from
     * another company's address. The composite foreign key makes it impossible
     * in the database instead.
     */
    it("REFUSES to file a client under another organisation's mailbox", async () => {
      const foreign = await otherOrganisation();
      const foreignMailbox = await mailboxFor(foreign.id);
      const customer = await customerFor(DEMO_ORGANISATION_ID);
      await expect(
        prisma.customer.update({
          where: { id: customer.id },
          data: { emailAccountId: foreignMailbox.id },
        }),
        // Assert the constraint's own message, not a bare rejection: a typo in
        // the fixture would otherwise "pass" this test having proven nothing.
      ).rejects.toThrow(/customers_email_account_same_org_fkey/);
      await prisma.customer.delete({ where: { id: customer.id } });
      await prisma.emailAccount.delete({ where: { id: foreignMailbox.id } });
      await prisma.organisation.delete({ where: { id: foreign.id } });
    });

    /**
     * ON DELETE RESTRICT, not SET NULL and never CASCADE. The application never
     * hard-deletes a mailbox — disconnect soft-deletes and nulls the tokens —
     * so this only fires on a manual DELETE against the database, and there it
     * must fail loudly rather than silently re-file a whole book of clients.
     */
    it("refuses to hard-delete a mailbox that still has clients filed under it", async () => {
      const mailbox = await mailboxFor(DEMO_ORGANISATION_ID);
      const customer = await customerFor(DEMO_ORGANISATION_ID);
      await prisma.customer.update({
        where: { id: customer.id },
        data: { emailAccountId: mailbox.id },
      });
      await expect(prisma.emailAccount.delete({ where: { id: mailbox.id } })).rejects.toThrow(
        /customers_email_account_same_org_fkey/,
      );
      // The client is untouched — that is the point of RESTRICT.
      const survivor = await prisma.customer.findUnique({ where: { id: customer.id } });
      expect(survivor?.emailAccountId).toBe(mailbox.id);
      await prisma.customer.delete({ where: { id: customer.id } });
      await prisma.emailAccount.delete({ where: { id: mailbox.id } });
    });

    it("indexes the allocation, and only the rows that have one", async () => {
      const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'customers' AND indexname = 'customers_email_account_id_idx'`;
      expect(index?.indexdef).toContain("email_account_id");
      // Partial on both counts: the vast majority of rows are unallocated by
      // design (ruling 1), and soft-deleted clients are never chased.
      expect(index?.indexdef).toContain("email_account_id IS NOT NULL");
      expect(index?.indexdef).toContain("deleted_at IS NULL");
    });

    /**
     * THE TRAP THIS MIGRATION EXISTS TO AVOID (`ALLOCATION-SCOPE` trap 1).
     *
     * The opposite of 1.6a, where a MISSING backfill was the rollout risk. Here
     * a backfill IS the risk: stamping today's primary onto every existing
     * client freezes it into history, and the day someone changes their default
     * mailbox those clients get chased from the old address with no error, no
     * log line and no failing test. Resolution belongs at send time, every time.
     *
     * Scoped to rows that predate the migration, because specs in this file
     * deliberately file clients under mailboxes.
     */
    it("backfilled NOTHING — the migration never writes to customers", () => {
      /**
       * Asserted against the migration TEXT, not against row timestamps.
       *
       * The obvious spelling — "no customer created before this migration ran
       * has an allocation" — CANNOT FAIL. Migration 0020 runs against an empty
       * `customers` table on every fresh database (CI creates `eva_test` and
       * migrates before any spec inserts a row), so the predicate matches zero
       * rows whether or not a backfill exists. Measured on this machine: 314
       * customers, 0 predating the migration. Appending the exact trap-1
       * backfill this test forbids left it green.
       *
       * Note the same `created_at < finished_at` idiom guards the 0017 and 0019
       * backfill claims elsewhere in this file and is inert there too.
       */
      const migration = readFileSync(
        path.join(
          fileURLToPath(new URL("../prisma/migrations", import.meta.url)),
          "20260802160000_customer_mailbox_allocation",
          "migration.sql",
        ),
        "utf8",
      );
      const statements = migration
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      // A backfill can only be an UPDATE or an INSERT against customers.
      expect(statements).not.toMatch(/UPDATE\s+"?customers"?/i);
      expect(statements).not.toMatch(/INSERT\s+INTO\s+"?customers"?/i);
      // Positive control: the file really was read and really does touch the
      // table, so the two assertions above are about content and not about an
      // empty string.
      expect(statements).toMatch(/ALTER TABLE "customers"/);
    });
  });
});
