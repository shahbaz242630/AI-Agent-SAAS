import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import type { ReminderActionType, ReminderStepKey, ScheduledActionStatus } from "@eva/types";
import { todayInTimezone } from "../src/modules/invoices/invoice-status.js";
import type { scheduleInvoiceReminders } from "../src/modules/reminders/reminder-actions.js";
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
 * Minimal module-boundary double (the ONLY mock in this file — the invoices
 * transactionality pattern, plan §6): when armed with an organisation id,
 * `scheduleInvoiceReminders` rejects for that org so the reconcile sweep's
 * per-org failure isolation can be proven. Disarmed it delegates to the real
 * implementation, so every other test exercises the genuine scheduling code.
 */
const reminderActionsMock = vi.hoisted(() => ({ failForOrganisationId: "" }));

vi.mock("../src/modules/reminders/reminder-actions.js", async (importOriginal) => {
  const actual = await importOriginal<{
    scheduleInvoiceReminders: typeof scheduleInvoiceReminders;
  }>();
  return {
    ...actual,
    scheduleInvoiceReminders: (
      tx: Parameters<typeof scheduleInvoiceReminders>[0],
      input: Parameters<typeof scheduleInvoiceReminders>[1],
    ): ReturnType<typeof scheduleInvoiceReminders> => {
      if (reminderActionsMock.failForOrganisationId === input.organisationId) {
        return Promise.reject(new Error("forced reconcile failure (test double)"));
      }
      return actual.scheduleInvoiceReminders(tx, input);
    },
  };
});

/**
 * Reminder sequence (Slice 1.5; plan §3/§6): lazy default-sequence
 * provisioning, step configuration with org-wide recompute, the per-invoice
 * scheduled-action read model, and the internal reconcile sweep (founder
 * ruling §7.8 — list_active_organisations enumeration, per-org tenant
 * transactions, failure isolation). Runs against real Postgres as eva_app.
 */

const DAY_MS = 86_400_000;

interface ActionRow {
  id: string;
  reminderStepId: string;
  actionType: string;
  scheduledDate: Date;
  status: string;
}

/** The six BRD 4.1 default stages, keyed for order-independent assertions. */
const DEFAULT_STEPS: Record<
  ReminderStepKey,
  { offsetDays: number; actionType: ReminderActionType }
> = {
  pre_due_3: { offsetDays: -3, actionType: "email" },
  due_date: { offsetDays: 0, actionType: "email" },
  overdue_7: { offsetDays: 7, actionType: "email" },
  overdue_14: { offsetDays: 14, actionType: "email" },
  overdue_30: { offsetDays: 30, actionType: "email" },
  final_escalation: { offsetDays: 37, actionType: "internal_escalation" },
};

/** YYYY-MM-DD of a UTC-midnight @db.Date value. */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("Reminders (Slice 1.5)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let otherOrg: FixtureOrg;
  let getOrg: FixtureOrg;
  let overrideOrg: FixtureOrg;
  let reconcileOrg: FixtureOrg;
  const tokens = new Map<string, string>();

  function tokenFor(organisation: FixtureOrg, roleKey: string): string {
    return tokens.get(`${organisation.id}:${roleKey}`)!;
  }

  async function createActiveInvoice(
    organisationId: string,
    options: { dueInDays?: number; withContact?: boolean; email?: string | null } = {},
  ): Promise<{ customerId: string; contactId: string | null; invoiceId: string }> {
    const suffix = randomUUID().slice(0, 8);
    const customer = await owner.customer.create({
      data: { organisationId, name: `REM Customer ${suffix}` },
    });
    let contactId: string | null = null;
    if (options.withContact !== false) {
      const contact = await owner.contact.create({
        data: {
          organisationId,
          customerId: customer.id,
          name: `REM Contact ${suffix}`,
          email: options.email === undefined ? `rem-${suffix}@example.test` : options.email,
        },
      });
      contactId = contact.id;
    }
    const invoice = await owner.invoice.create({
      data: {
        organisationId,
        customerId: customer.id,
        contactId,
        invoiceNumber: `REM-${suffix}`,
        amountMinorUnits: 10000,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + (options.dueInDays ?? 10) * DAY_MS),
        status: "active",
      },
    });
    return { customerId: customer.id, contactId, invoiceId: invoice.id };
  }

  async function actionsOf(invoiceId: string): Promise<ActionRow[]> {
    return owner.scheduledAction.findMany({
      where: { invoiceId },
      orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }],
    });
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "reminders", ["owner", "finance", "read_only"]);
    otherOrg = await createOrgWithMembers(owner, "reminders-b", ["owner"]);
    getOrg = await createOrgWithMembers(owner, "reminders-get", ["owner"]);
    overrideOrg = await createOrgWithMembers(owner, "reminders-ovr", ["read_only"]);
    reconcileOrg = await createOrgWithMembers(owner, "reminders-rec", ["owner"]);
    for (const organisation of [org, otherOrg, getOrg, overrideOrg, reconcileOrg]) {
      for (const member of organisation.members) {
        tokens.set(
          `${organisation.id}:${member.roleKey}`,
          await signToken({ sub: member.authUserId, email: member.email }),
        );
      }
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  describe("GET reminder-sequence", () => {
    it("lazily provisions exactly the six BRD 4.1 default steps on first read", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${getOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(getOrg, "owner")}`)
        .expect(200);

      const body = response.body as {
        id: string;
        name: string;
        isDefault: boolean;
        steps: {
          id: string;
          key: ReminderStepKey;
          offsetDays: number;
          actionType: ReminderActionType;
          enabled: boolean;
        }[];
      };
      expect(body.isDefault).toBe(true);
      expect(body.steps).toHaveLength(6);
      const byKey = new Map(body.steps.map((step) => [step.key, step]));
      for (const [key, expected] of Object.entries(DEFAULT_STEPS)) {
        const step = byKey.get(key as ReminderStepKey);
        expect(step, `step ${key} must exist`).toBeDefined();
        expect(step?.offsetDays).toBe(expected.offsetDays);
        expect(step?.actionType).toBe(expected.actionType);
        expect(step?.enabled).toBe(true);
      }

      const sequences = await owner.reminderSequence.findMany({
        where: { organisationId: getOrg.id },
        include: { steps: true },
      });
      expect(sequences).toHaveLength(1);
      expect(sequences[0]?.steps).toHaveLength(6);
    });

    it("second GET is idempotent (no duplicate rows, same ids)", async () => {
      const first = await request(app.getHttpServer())
        .get(`/organisations/${getOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(getOrg, "owner")}`)
        .expect(200);
      const second = await request(app.getHttpServer())
        .get(`/organisations/${getOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(getOrg, "owner")}`)
        .expect(200);
      expect(second.body).toEqual(first.body);
      expect(await owner.reminderSequence.count({ where: { organisationId: getOrg.id } })).toBe(1);
      expect(
        await owner.reminderStep.count({
          where: { sequence: { organisationId: getOrg.id }, deletedAt: null },
        }),
      ).toBe(6);
    });

    it("GET never writes audit rows (reads are not audited, BRD 14)", async () => {
      const before = await owner.auditLog.count({ where: { organisationId: getOrg.id } });
      await request(app.getHttpServer())
        .get(`/organisations/${getOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(getOrg, "owner")}`)
        .expect(200);
      expect(await owner.auditLog.count({ where: { organisationId: getOrg.id } })).toBe(before);
    });

    it("unauthenticated → 401", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${getOrg.id}/reminder-sequence`)
        .expect(401);
    });

    it("cross-tenant → 404 (the API never confirms the org exists, BRD 15)", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${org.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(otherOrg, "owner")}`)
        .expect(404);
    });
  });

  describe("PATCH reminder-sequence step", () => {
    let stepsByKey: Map<ReminderStepKey, { id: string }>;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(org, "owner")}`)
        .expect(200);
      stepsByKey = new Map(
        (response.body.steps as { id: string; key: ReminderStepKey }[]).map((step) => [
          step.key,
          step,
        ]),
      );
    });

    function patchStep(
      organisation: FixtureOrg,
      roleKey: string,
      stepId: string,
      body: unknown,
    ): request.Test {
      return request(app.getHttpServer())
        .patch(`/organisations/${organisation.id}/reminder-sequence/steps/${stepId}`)
        .set("Authorization", `Bearer ${tokenFor(organisation, roleKey)}`)
        .send(body as object);
    }

    it("enable/disable and offset edits persist; audit row carries changed fields only", async () => {
      const stepId = stepsByKey.get("pre_due_3")!.id;
      const response = await patchStep(org, "finance", stepId, {
        enabled: false,
        offsetDays: -5,
      }).expect(200);
      expect(response.body).toMatchObject({ id: stepId, enabled: false, offsetDays: -5 });

      const stored = await owner.reminderStep.findUniqueOrThrow({ where: { id: stepId } });
      expect(stored.enabled).toBe(false);
      expect(stored.offsetDays).toBe(-5);

      const audit = await owner.auditLog.findFirst({
        where: { organisationId: org.id, action: "reminder_step.updated", entityId: stepId },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).toBeDefined();
      expect(audit?.metadata).toMatchObject({
        changedFields: expect.arrayContaining(["enabled", "offsetDays"]),
      });
      // Counts/ids/field names only — never amounts or personal data (BRD 14).
      expect(JSON.stringify(audit?.metadata)).not.toContain("@");
      // restore for the recompute test below
      await patchStep(org, "finance", stepId, { enabled: true, offsetDays: -3 }).expect(200);
    });

    it("org-wide recompute: pending actions are cancelled and recreated per the new config", async () => {
      const fixture = await createActiveInvoice(org.id, { dueInDays: 10 });
      const overdue7 = stepsByKey.get("overdue_7")!.id;

      await patchStep(org, "finance", overdue7, { offsetDays: 9 }).expect(200);
      const firstRound = await actionsOf(fixture.invoiceId);
      expect(firstRound).toHaveLength(6);
      expect(firstRound.every((action) => action.status === "pending")).toBe(true);
      const firstRoundIds = new Set(firstRound.map((action) => action.id));

      await patchStep(org, "finance", overdue7, { offsetDays: 11 }).expect(200);
      const secondRound = await actionsOf(fixture.invoiceId);
      const live = secondRound.filter((action) => action.status !== "cancelled");
      const cancelled = secondRound.filter((action) => action.status === "cancelled");
      // cancelled is terminal (founder ruling 2026-07-26): the whole first
      // round stays cancelled, and the replacement round is six FRESH rows —
      // recompute is always cancel + insert-new, never a revive.
      expect(cancelled).toHaveLength(6);
      expect(cancelled.every((action) => firstRoundIds.has(action.id))).toBe(true);
      expect(live).toHaveLength(6);
      expect(live.every((action) => !firstRoundIds.has(action.id))).toBe(true);
      expect(live.every((action) => action.status === "pending")).toBe(true);

      // The edited step fires at due_date + 11 (org-local calendar day).
      const invoice = await owner.invoice.findUniqueOrThrow({
        where: { id: fixture.invoiceId },
      });
      const expectedDate = ymd(new Date(invoice.dueDate.getTime() + 11 * DAY_MS));
      const moved = live.find((action) => action.reminderStepId === overdue7);
      expect(ymd(moved!.scheduledDate)).toBe(expectedDate);

      // Audit on every mutation (BRD 15): the recompute writes one
      // reminder_action.cancelled and one reminder_action.scheduled per
      // affected invoice, counts + entity ids only (BRD 14).
      const cancelAudit = await owner.auditLog.findFirst({
        where: {
          organisationId: org.id,
          action: "reminder_action.cancelled",
          entityType: "invoice",
          entityId: fixture.invoiceId,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit?.metadata).toMatchObject({ cancelledCount: 6, reason: "recompute" });
      const scheduleAudit = await owner.auditLog.findFirst({
        where: {
          organisationId: org.id,
          action: "reminder_action.scheduled",
          entityType: "invoice",
          entityId: fixture.invoiceId,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(scheduleAudit).toBeDefined();
      expect(scheduleAudit?.metadata).toMatchObject({ scheduledCount: 6 });
      const auditBlob = JSON.stringify([cancelAudit?.metadata, scheduleAudit?.metadata]);
      expect(auditBlob).not.toContain("@");
      expect(auditBlob).not.toContain(invoice.invoiceNumber);

      // restore the default offset for later tests
      await patchStep(org, "finance", overdue7, { offsetDays: 7 }).expect(200);
    });

    it("neither field → 400", async () => {
      await patchStep(org, "finance", stepsByKey.get("due_date")!.id, {}).expect(400);
    });

    it("offset −31 / +91 / non-integer → 400 (plan §3 bounds are −30…+90)", async () => {
      const stepId = stepsByKey.get("due_date")!.id;
      await patchStep(org, "finance", stepId, { offsetDays: -31 }).expect(400);
      await patchStep(org, "finance", stepId, { offsetDays: 91 }).expect(400);
      await patchStep(org, "finance", stepId, { offsetDays: 1.5 }).expect(400);
    });

    it("reminders:write denied for read_only → 403", async () => {
      await patchStep(org, "read_only", stepsByKey.get("due_date")!.id, {
        offsetDays: 1,
      }).expect(403);
    });

    it("org override honoured: a normally-denied role granted reminders:write succeeds", async () => {
      // Custom mapping replaces the BRD default matrix wholesale (plan §7.1),
      // so the override grants BOTH keys; write is the one read_only lacks by
      // default.
      const readOnlyRole = await owner.role.findUniqueOrThrow({ where: { key: "read_only" } });
      await owner.organisationRolePermission.createMany({
        data: ["reminders:read", "reminders:write"].map((permissionKey) => ({
          organisationId: overrideOrg.id,
          roleId: readOnlyRole.id,
          permissionKey,
        })),
      });

      const sequence = await request(app.getHttpServer())
        .get(`/organisations/${overrideOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(overrideOrg, "read_only")}`)
        .expect(200);
      const stepId = (sequence.body.steps as { id: string; key: string }[]).find(
        (step) => step.key === "due_date",
      )!.id;
      await patchStep(overrideOrg, "read_only", stepId, { offsetDays: 2 }).expect(200);

      // The same custom mapping denies a key nobody granted (defence in depth).
      await request(app.getHttpServer())
        .get(`/organisations/${overrideOrg.id}/customers`)
        .set("Authorization", `Bearer ${tokenFor(overrideOrg, "read_only")}`)
        .expect(403);
    });

    it("cross-tenant step id → 404", async () => {
      const otherSequence = await request(app.getHttpServer())
        .get(`/organisations/${otherOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(otherOrg, "owner")}`)
        .expect(200);
      const otherStepId = (otherSequence.body.steps as { id: string }[])[0]!.id;
      await patchStep(org, "owner", otherStepId, { offsetDays: 1 }).expect(404);
    });
  });

  describe("GET scheduled-actions", () => {
    let fixture: { customerId: string; contactId: string | null; invoiceId: string };

    beforeAll(async () => {
      fixture = await createActiveInvoice(org.id, { dueInDays: 10 });
      // Trigger scheduling via a no-op-shaped recompute (offset 7 → 7 is a real write).
      const sequence = await owner.reminderSequence.findFirstOrThrow({
        where: { organisationId: org.id, isDefault: true },
        include: { steps: true },
      });
      const overdue7 = sequence.steps.find((step) => step.key === "overdue_7")!;
      await request(app.getHttpServer())
        .patch(`/organisations/${org.id}/reminder-sequence/steps/${overdue7.id}`)
        .set("Authorization", `Bearer ${tokenFor(org, "finance")}`)
        .send({ offsetDays: 7 })
        .expect(200);
    });

    it("returns the invoice's actions with the ScheduledActionDto shape", async () => {
      const response = await request(app.getHttpServer())
        .get(
          `/organisations/${org.id}/customers/${fixture.customerId}/invoices/${fixture.invoiceId}/scheduled-actions`,
        )
        .set("Authorization", `Bearer ${tokenFor(org, "read_only")}`)
        .expect(200);

      const actions = response.body as {
        id: string;
        invoiceId: string;
        reminderStepId: string;
        actionType: ReminderActionType;
        scheduledDate: string;
        status: ScheduledActionStatus;
        idempotencyKey: string;
      }[];
      expect(actions).toHaveLength(6);
      for (const action of actions) {
        expect(action.invoiceId).toBe(fixture.invoiceId);
        expect(action.scheduledDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(action.status).toBe("pending");
        expect(action.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it("cross-tenant invoice id → 404", async () => {
      const foreign = await createActiveInvoice(otherOrg.id);
      await request(app.getHttpServer())
        .get(
          `/organisations/${org.id}/customers/${foreign.customerId}/invoices/${foreign.invoiceId}/scheduled-actions`,
        )
        .set("Authorization", `Bearer ${tokenFor(org, "owner")}`)
        .expect(404);
    });

    it("wrong customerId → 404", async () => {
      const otherCustomer = await owner.customer.create({
        data: { organisationId: org.id, name: `REM Wrong Customer ${randomUUID().slice(0, 8)}` },
      });
      await request(app.getHttpServer())
        .get(
          `/organisations/${org.id}/customers/${otherCustomer.id}/invoices/${fixture.invoiceId}/scheduled-actions`,
        )
        .set("Authorization", `Bearer ${tokenFor(org, "owner")}`)
        .expect(404);
    });

    it("unauthenticated → 401", async () => {
      await request(app.getHttpServer())
        .get(
          `/organisations/${org.id}/customers/${fixture.customerId}/invoices/${fixture.invoiceId}/scheduled-actions`,
        )
        .expect(401);
    });
  });

  describe("POST /internal/reminders/reconcile", () => {
    let sequenceSteps: { id: string; key: string }[];
    let dueFixture: { customerId: string; invoiceId: string };
    let backfillFixture: { customerId: string; invoiceId: string };
    let duePendingId: string;
    let futurePendingId: string;
    let escalationActionId: string;

    function reconcile(secret?: string): request.Test {
      const req = request(app.getHttpServer()).post("/internal/reminders/reconcile").send({});
      return secret === undefined ? req : req.set("x-internal-secret", secret);
    }

    beforeAll(async () => {
      // Provision the org's sequence, then build actions directly in the DB
      // (the sweep's input rows predate any hook wiring — Task 5).
      const response = await request(app.getHttpServer())
        .get(`/organisations/${reconcileOrg.id}/reminder-sequence`)
        .set("Authorization", `Bearer ${tokenFor(reconcileOrg, "owner")}`)
        .expect(200);
      sequenceSteps = (response.body.steps as { id: string; key: string }[]).map((step) => ({
        id: step.id,
        key: step.key,
      }));
      const stepId = (key: string): string => sequenceSteps.find((s) => s.key === key)!.id;

      const today = todayInTimezone("Europe/London");
      dueFixture = await createActiveInvoice(reconcileOrg.id, { dueInDays: 10 });
      const base = {
        organisationId: reconcileOrg.id,
        invoiceId: dueFixture.invoiceId,
        idempotencyKey: randomUUID(),
      };
      duePendingId = (
        await owner.scheduledAction.create({
          data: {
            ...base,
            reminderStepId: stepId("due_date"),
            actionType: "email",
            scheduledDate: today,
            status: "pending",
          },
        })
      ).id;
      futurePendingId = (
        await owner.scheduledAction.create({
          data: {
            ...base,
            reminderStepId: stepId("overdue_7"),
            actionType: "email",
            scheduledDate: new Date(today.getTime() + 5 * DAY_MS),
            status: "pending",
          },
        })
      ).id;
      escalationActionId = (
        await owner.scheduledAction.create({
          data: {
            ...base,
            reminderStepId: stepId("final_escalation"),
            actionType: "internal_escalation",
            scheduledDate: today,
            status: "ready",
          },
        })
      ).id;

      // An active invoice with zero scheduled actions — the backfill case.
      backfillFixture = await createActiveInvoice(reconcileOrg.id, { dueInDays: 20 });
    });

    /**
     * Slice 1.6a Task 5 — the real teeth of BRD §3.4.
     *
     * `requirePermission` only guards someone clicking in a browser. It does
     * nothing about this sweep, which enumerates organisations through
     * `list_active_organisations()` and schedules reminders for each. Before
     * migration 0018 a customer could switch Invoice Chasing off and Eva would
     * carry on quietly scheduling chases against their customers — a disabled
     * module that hides a button but keeps acting is worse than no switch at
     * all, because the customer believes they have stopped it.
     *
     * Asserted at the enumeration rather than through the sweep's counters,
     * because that is the property: an un-entitled organisation must not even
     * be handed to the loop.
     */
    describe("a disabled module stops the sweep (Slice 1.6a)", () => {
      async function setEmailModule(enabled: boolean): Promise<void> {
        await owner.organisationModule.updateMany({
          where: { organisationId: reconcileOrg.id, moduleKey: "email_credit_controller" },
          data: { enabled },
        });
      }

      async function sweptOrganisations(): Promise<string[]> {
        const rows = await owner.$queryRaw<{ list_active_organisations: string }[]>`
          SELECT * FROM list_active_organisations()`;
        return rows.map((row) => row.list_active_organisations);
      }

      it("enumerates the organisation while its module is enabled", async () => {
        await setEmailModule(true);
        expect(await sweptOrganisations()).toContain(reconcileOrg.id);
      });

      it("skips it once the module is disabled, and resumes when re-enabled", async () => {
        await setEmailModule(false);
        try {
          expect(await sweptOrganisations()).not.toContain(reconcileOrg.id);
        } finally {
          await setEmailModule(true);
        }
        // Switching a product back on must resume it — a one-way door would be
        // a worse bug than never stopping.
        expect(await sweptOrganisations()).toContain(reconcileOrg.id);
      });

      it("a soft-deleted module row also stops the sweep — fail closed", async () => {
        await owner.organisationModule.updateMany({
          where: { organisationId: reconcileOrg.id, moduleKey: "email_credit_controller" },
          data: { deletedAt: new Date() },
        });
        try {
          expect(await sweptOrganisations()).not.toContain(reconcileOrg.id);
        } finally {
          await owner.organisationModule.updateMany({
            where: { organisationId: reconcileOrg.id, moduleKey: "email_credit_controller" },
            data: { deletedAt: null },
          });
        }
      });

      /** The function is the only controlled cross-tenant path in the schema
       *  (SECURITY DEFINER, migration 0010). Replacing its body must not have
       *  cost eva_app the grant it runs on — `CREATE OR REPLACE` preserves the
       *  ACL, but the sweep dies at runtime if that is ever wrong. */
      it("eva_app can still execute the replaced function", async () => {
        const rows = await owner.$queryRaw<{ has: boolean }[]>`
          SELECT has_function_privilege('eva_app', 'list_active_organisations()', 'EXECUTE') AS has`;
        expect(rows[0]?.has).toBe(true);
      });
    });

    it("missing secret → 401", async () => {
      await reconcile().expect(401);
    });

    it("wrong secret → 401", async () => {
      await reconcile("wrong-secret-wrong-secret-wrong-12").expect(401);
    });

    it("correct secret (no JWT — internal route) flips due pending → ready, future untouched", async () => {
      const response = await reconcile(TEST_INTERNAL_API_SECRET).expect(200);
      const body = response.body as { processed: number; failed: string[] };
      expect(typeof body.processed).toBe("number");
      expect(body.processed).toBeGreaterThanOrEqual(1);
      expect(body.failed).toEqual([]);

      const due = await owner.scheduledAction.findUniqueOrThrow({ where: { id: duePendingId } });
      expect(due.status).toBe("ready");
      const future = await owner.scheduledAction.findUniqueOrThrow({
        where: { id: futurePendingId },
      });
      expect(future.status).toBe("pending");
    });

    it("due escalation action creates exactly one human_escalations row; second call none", async () => {
      const escalations = await owner.humanEscalation.findMany({
        where: { scheduledActionId: escalationActionId },
      });
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatchObject({
        organisationId: reconcileOrg.id,
        invoiceId: dueFixture.invoiceId,
        reason: "final_reminder_escalation",
        status: "open",
      });

      await reconcile(TEST_INTERNAL_API_SECRET).expect(200);
      expect(
        await owner.humanEscalation.count({ where: { scheduledActionId: escalationActionId } }),
      ).toBe(1);

      const audits = await owner.auditLog.findMany({
        where: { organisationId: reconcileOrg.id, action: "escalation.created" },
      });
      expect(audits).toHaveLength(1);
      // ids/reason only — no personal data (BRD 14).
      expect(JSON.stringify(audits[0]?.metadata)).not.toContain("@");
    });

    it("backfills an active invoice that has zero non-cancelled actions", async () => {
      const actions = await actionsOf(backfillFixture.invoiceId);
      expect(actions).toHaveLength(6);
      expect(actions.every((action) => action.status === "pending")).toBe(true);
    });

    it("second call is a no-op: no status regressions, no duplicates", async () => {
      const before = await owner.scheduledAction.findMany({
        where: { organisationId: reconcileOrg.id },
        select: { id: true, status: true },
      });
      await reconcile(TEST_INTERNAL_API_SECRET).expect(200);
      const after = await owner.scheduledAction.findMany({
        where: { organisationId: reconcileOrg.id },
        select: { id: true, status: true },
      });
      expect(after).toEqual(before);
    });

    it("per-org failure isolation: one org's failure lands in `failed`, others still process, HTTP 200", async () => {
      // Two fresh orgs, each holding a backfill candidate (active invoice,
      // zero actions). The armed double fails ONLY the first org's scheduling.
      const failingOrg = await createOrgWithMembers(owner, "reminders-fail", ["owner"]);
      const healthyOrg = await createOrgWithMembers(owner, "reminders-ok", ["owner"]);
      const failing = await createActiveInvoice(failingOrg.id, { dueInDays: 15 });
      const healthy = await createActiveInvoice(healthyOrg.id, { dueInDays: 15 });

      reminderActionsMock.failForOrganisationId = failingOrg.id;
      let body: { processed: number; failed: string[] };
      try {
        const response = await reconcile(TEST_INTERNAL_API_SECRET).expect(200);
        body = response.body as { processed: number; failed: string[] };
      } finally {
        reminderActionsMock.failForOrganisationId = "";
      }

      expect(body.failed).toContain(failingOrg.id);
      expect(body.failed).not.toContain(healthyOrg.id);
      expect(body.processed).toBeGreaterThanOrEqual(1);

      // The failed org rolled back cleanly; the healthy org was backfilled.
      expect(await owner.scheduledAction.count({ where: { invoiceId: failing.invoiceId } })).toBe(
        0,
      );
      expect(await actionsOf(healthy.invoiceId)).toHaveLength(6);
    });
  });
});

describe("Reminders module: structural no-send guard (plan §8 risk 7)", () => {
  it("no module file imports or references any email-sending/provider path", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const moduleDir = path.resolve(__dirname, "../src/modules/reminders");
    for (const file of readdirSync(moduleDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(path.join(moduleDir, file), "utf8");
      // 1.5 writes only the queue; sending arrives with 1.7 behind an
      // integrations adapter — never scattered direct provider calls.
      expect(source, `${file} must not reference sending/provider code`).not.toMatch(
        /resend|sendgrid|nodemailer|@microsoft\/graph|sendMail|sendEmail|modules\/integrations/i,
      );
    }
  });
});

describe("Contact spacing under concurrent activation (BRD 4.1)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let financeToken: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "reminders-spacing", ["finance"]);
    const finance = org.members[0]!;
    financeToken = await signToken({ sub: finance.authUserId, email: finance.email });
    // Provision the sequence up front — this test races SCHEDULING, not
    // first-touch provisioning (whose honest loud-failure path is documented
    // in reminder-actions.ensureDefaultSequence).
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/reminder-sequence`)
      .set("Authorization", `Bearer ${financeToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("two concurrent activations for invoices sharing a contact honour the 3-day spacing invariant", async () => {
    const suffix = randomUUID().slice(0, 8);
    const customer = await owner.customer.create({
      data: { organisationId: org.id, name: `REM Spacing Customer ${suffix}` },
    });
    const contact = await owner.contact.create({
      data: {
        organisationId: org.id,
        customerId: customer.id,
        name: `REM Spacing Contact ${suffix}`,
        email: `rem-spacing-${suffix}@example.test`,
      },
    });
    const dueDate = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);

    const createDraft = async (invoiceNumber: string): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/customers/${customer.id}/invoices`)
        .set("Authorization", `Bearer ${financeToken}`)
        .send({ invoiceNumber, amountMinorUnits: 5000, dueDate, contactId: contact.id })
        .expect(201);
      return (response.body as { id: string }).id;
    };
    const activate = (id: string) =>
      request(app.getHttpServer())
        .post(`/organisations/${org.id}/customers/${customer.id}/invoices/${id}/activate`)
        .set("Authorization", `Bearer ${financeToken}`)
        .expect(200);

    const [firstId, secondId] = await Promise.all([
      createDraft(`REM-SP-A-${suffix}`),
      createDraft(`REM-SP-B-${suffix}`),
    ]);
    // Same due date, same contact, activated concurrently: the advisory lock
    // serialises the two scheduling transactions, so the loser's dates defer.
    await Promise.all([activate(firstId), activate(secondId)]);

    const rows = await owner.scheduledAction.findMany({
      where: { invoiceId: { in: [firstId, secondId] }, status: { not: "cancelled" } },
      include: { reminderStep: { select: { key: true } } },
    });
    expect(rows).toHaveLength(12);
    // Per EMAIL step, the two invoices' dates must be ≥3 days apart (same raw
    // date for both — spacing must have separated them). internal_escalation
    // is exempt from contact spacing (founder ruling 2026-07-27 — internal
    // handover, not a contact-facing reminder): both fire on the same day.
    const keys = [...new Set(rows.map((row) => row.reminderStep.key))];
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      const dates = rows
        .filter((row) => row.reminderStep.key === key)
        .map((row) => row.scheduledDate.getTime());
      expect(dates).toHaveLength(2);
      if (key === "final_escalation") {
        expect(dates[0], "escalations are exempt from contact spacing").toBe(dates[1]);
      } else {
        expect(
          Math.abs(dates[0]! - dates[1]!),
          `step ${key} dates too close`,
        ).toBeGreaterThanOrEqual(3 * DAY_MS);
      }
    }
  });
});
