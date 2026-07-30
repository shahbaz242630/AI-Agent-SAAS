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
  it("creates exactly the Phase 0 + Slice 1.1 + Slice 1.2 + Slice 1.3 + Slice 1.4 + Slice 1.5 + Slice 1.6 tables", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "_prisma_migrations",
      "audit_logs",
      "contacts",
      "customers",
      "email_accounts",
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
    "email_accounts",
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
