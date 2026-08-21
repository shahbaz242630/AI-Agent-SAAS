import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import type { scheduleInvoiceReminders } from "../src/products/invoice-follow-up/reminders/reminder-actions.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
  type FixtureUser,
} from "./support.js";

/**
 * Minimal module-boundary double (plan §6 transactionality binding — the ONLY
 * mock in this file): when armed, `scheduleInvoiceReminders` rejects so the
 * activation hook fails mid-transaction and the test can prove the status
 * change rolls back with it. Disarmed it delegates to the real implementation,
 * so every other test in this file exercises the genuine scheduling code.
 */
const reminderActionsMock = vi.hoisted(() => ({ failScheduling: false }));

vi.mock(
  "../src/products/invoice-follow-up/reminders/reminder-actions.js",
  async (importOriginal) => {
    const actual = await importOriginal<{
      scheduleInvoiceReminders: typeof scheduleInvoiceReminders;
    }>();
    return {
      ...actual,
      scheduleInvoiceReminders: (
        tx: Parameters<typeof scheduleInvoiceReminders>[0],
        input: Parameters<typeof scheduleInvoiceReminders>[1],
      ): ReturnType<typeof scheduleInvoiceReminders> => {
        if (reminderActionsMock.failScheduling) {
          return Promise.reject(new Error("forced scheduling failure (test double)"));
        }
        return actual.scheduleInvoiceReminders(tx, input);
      },
    };
  },
);

/**
 * Invoice records (Slice 1.2). Routes are nested under
 * /organisations/:organisationId/customers/:customerId/invoices.
 */

/** YYYY-MM-DD for (today + offsetDays) in the given timezone. */
function orgDate(offsetDays: number, timezone = "Europe/London"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  const base = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe("Invoices: CRUD, validation and permissions", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  let contactId: string;
  const tokens = new Map<string, string>();
  const membersByRole = new Map<string, FixtureUser>();

  const baseUrl = () => `/organisations/${org.id}/customers/${customerId}/invoices`;

  function createInvoice(overrides: Record<string, unknown> = {}, role = "finance"): request.Test {
    return request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .send({
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 12500,
        dueDate: orgDate(14),
        ...overrides,
      });
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "invoices", [
      "owner",
      "finance",
      "sales",
      "reception",
      "read_only",
    ]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      membersByRole.set(member.roleKey, member);
    }
    customerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Invoiced Customer Ltd",
          createdBy: membersByRole.get("owner")!.id,
        },
      })
    ).id;
    contactId = (
      await owner.contact.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          customerId,
          name: "Accounts Payable",
          email: "ap@invoiced.test",
          createdBy: membersByRole.get("owner")!.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("creates a draft invoice as finance (default write) → 201, audit-logged", async () => {
    const response = await createInvoice({ contactId }).expect(201);
    expect(response.body).toMatchObject({
      customerId,
      contactId,
      invoiceNumber: expect.any(String),
      amountMinorUnits: 12500,
      currency: "GBP",
      status: "draft",
      displayStatus: "draft",
    });
    expect(typeof response.body.issueDate).toBe("string");

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityType: "invoice", entityId: response.body.id },
    });
    expect(audit?.action).toBe("invoice.created");
  });

  it("creates an already-sent invoice directly as Active", async () => {
    const response = await createInvoice({ status: "active", dueDate: orgDate(14) }).expect(201);
    expect(response.body.status).toBe("active");
    // Active and not yet due → no computed override.
    expect(response.body.displayStatus).toBe("active");
  });

  it("rejects create as sales / reception / read_only (default read-only) → 403", async () => {
    for (const role of ["sales", "reception", "read_only"]) {
      await createInvoice({}, role).expect(403);
    }
  });

  it("rejects zero or negative amounts → 400", async () => {
    await createInvoice({ amountMinorUnits: 0 }).expect(400);
    await createInvoice({ amountMinorUnits: -500 }).expect(400);
    await createInvoice({ amountMinorUnits: 12.5 }).expect(400);
  });

  it("rejects a bad currency → 400", async () => {
    await createInvoice({ currency: "gbp" }).expect(400);
    await createInvoice({ currency: "GB" }).expect(400);
    await createInvoice({ currency: "GBPX" }).expect(400);
  });

  it("rejects a missing or malformed due date → 400", async () => {
    await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ invoiceNumber: "INV-NODATE", amountMinorUnits: 100 })
      .expect(400);
    await createInvoice({ dueDate: "30/07/2026" }).expect(400);
  });

  it("rejects a contact that belongs to a different customer → 400", async () => {
    const otherCustomer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Other Customer",
        createdBy: membersByRole.get("owner")!.id,
      },
    });
    const foreignContact = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: otherCustomer.id,
        name: "Foreign Contact",
        createdBy: membersByRole.get("owner")!.id,
      },
    });
    await createInvoice({ contactId: foreignContact.id }).expect(400);
  });

  it("rejects a nonexistent contact → 400", async () => {
    await createInvoice({ contactId: randomUUID() }).expect(400);
  });

  it("returns 404 when the customer belongs to another tenant", async () => {
    const otherOrg = await createOrgWithMembers(owner, "invoices-other", ["owner"]);
    const otherCustomer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: otherOrg.id,
        name: "Other Tenant Customer",
        createdBy: otherOrg.members[0]!.id,
      },
    });
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${otherCustomer.id}/invoices`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ invoiceNumber: "INV-XT", amountMinorUnits: 100, dueDate: orgDate(7) })
      .expect(404);
  });

  it("rejects a duplicate invoice number with a friendly 409", async () => {
    const invoiceNumber = `INV-DUP-${randomUUID().slice(0, 8)}`;
    await createInvoice({ invoiceNumber }).expect(201);
    const response = await createInvoice({ invoiceNumber }).expect(409);
    expect(response.body.message).toMatch(/already/i);
  });

  it("allows reuse of an invoice number after the original is soft-deleted", async () => {
    const invoiceNumber = `INV-REUSE-${randomUUID().slice(0, 8)}`;
    const first = await createInvoice({ invoiceNumber }).expect(201);
    await request(app.getHttpServer())
      .delete(`${baseUrl()}/${first.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
    await createInvoice({ invoiceNumber }).expect(201);
  });

  it("lists invoices as read_only, excluding soft-deleted ones", async () => {
    const doomed = await createInvoice().expect(201);
    await request(app.getHttpServer())
      .delete(`${baseUrl()}/${doomed.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);

    const response = await request(app.getHttpServer())
      .get(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    const ids = response.body.map((i: { id: string }) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(doomed.body.id);
  });

  it("filters the list by stored status", async () => {
    const invoice = await createInvoice().expect(201);
    await request(app.getHttpServer())
      .post(`${baseUrl()}/${invoice.body.id}/cancel`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);

    const response = await request(app.getHttpServer())
      .get(`${baseUrl()}?status=cancelled`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(response.body.every((i: { status: string }) => i.status === "cancelled")).toBe(true);
    expect(response.body.some((i: { id: string }) => i.id === invoice.body.id)).toBe(true);
  });

  it("filters the list by contact", async () => {
    const withContact = await createInvoice({ contactId }).expect(201);
    const response = await request(app.getHttpServer())
      .get(`${baseUrl()}?contactId=${contactId}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body.every((i: { contactId: string }) => i.contactId === contactId)).toBe(true);
    expect(response.body.some((i: { id: string }) => i.id === withContact.body.id)).toBe(true);
  });

  it("rejects an unknown status filter → 400", async () => {
    await request(app.getHttpServer())
      .get(`${baseUrl()}?status=bogus`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(400);
  });

  it("gets one invoice; cross-tenant and cross-customer ids are 404", async () => {
    const invoice = await createInvoice().expect(201);
    const fetched = await request(app.getHttpServer())
      .get(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(fetched.body.id).toBe(invoice.body.id);

    const otherCustomer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Sibling Customer",
        createdBy: membersByRole.get("owner")!.id,
      },
    });
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${otherCustomer.id}/invoices/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(404);
  });

  it("updates a draft invoice → 200, audit-logged; number conflicts → 409", async () => {
    const invoice = await createInvoice().expect(201);
    const response = await request(app.getHttpServer())
      .patch(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ amountMinorUnits: 9900, dueDate: orgDate(21) })
      .expect(200);
    expect(response.body.amountMinorUnits).toBe(9900);

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: invoice.body.id, action: "invoice.updated" },
    });
    expect(audit).toBeDefined();

    const other = await createInvoice().expect(201);
    await request(app.getHttpServer())
      .patch(`${baseUrl()}/${other.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ invoiceNumber: invoice.body.invoiceNumber })
      .expect(409);
  });

  /**
   * Slice 1.6c task 4: the edit screen has to be able to UNDO a recipient.
   *
   * Absent and null mean different things on a PATCH, and before this the
   * schema had no way to say the second one — `contactId` was `z.uuid()`, so
   * the only expressible update was "change it to somebody else". Picking the
   * wrong person was therefore permanent, and a screen offering "Nobody in
   * particular" would have accepted the click and changed nothing.
   *
   * The two halves are asserted together on purpose: null must CLEAR, and
   * absent must still LEAVE ALONE. A schema that accepted null by making the
   * whole field meaningless would pass the first half on its own.
   */
  it("clears the reminder recipient on an explicit null, and leaves it alone when absent", async () => {
    const invoice = await createInvoice({ contactId }).expect(201);
    expect(invoice.body.contactId).toBe(contactId);

    const untouched = await request(app.getHttpServer())
      .patch(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ amountMinorUnits: 4200 })
      .expect(200);
    expect(untouched.body.contactId).toBe(contactId);

    const cleared = await request(app.getHttpServer())
      .patch(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ contactId: null })
      .expect(200);
    expect(cleared.body.contactId).toBeNull();

    // Read back rather than trusting the response body — the column is what a
    // reminder is later addressed from.
    const stored = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.body.id } });
    expect(stored.contactId).toBeNull();
  });

  it("still refuses a contact belonging to somebody else on update", async () => {
    // Nullable must not have loosened the check that a REAL id is validated.
    const invoice = await createInvoice().expect(201);
    await request(app.getHttpServer())
      .patch(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ contactId: randomUUID() })
      .expect(400);
  });

  it("rejects a status field on update payloads → 400 (state machine only)", async () => {
    const invoice = await createInvoice().expect(201);
    await request(app.getHttpServer())
      .patch(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ status: "active" })
      .expect(400);
  });

  it("blocks update and delete outside Draft → 409", async () => {
    const invoice = await createInvoice({ status: "active" }).expect(201);
    await request(app.getHttpServer())
      .patch(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ amountMinorUnits: 100 })
      .expect(409);
    await request(app.getHttpServer())
      .delete(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(409);
  });

  it("soft-deletes a draft → 200, audit-logged, subsequent reads 404", async () => {
    const invoice = await createInvoice().expect(201);
    await request(app.getHttpServer())
      .delete(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(404);

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: invoice.body.id, action: "invoice.deleted" },
    });
    expect(audit).toBeDefined();
  });

  it("never writes audit entries on reads", async () => {
    const invoice = await createInvoice().expect(201);
    const before = await owner.auditLog.count({
      where: { organisationId: org.id, entityType: "invoice" },
    });
    await request(app.getHttpServer())
      .get(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    const after = await owner.auditLog.count({
      where: { organisationId: org.id, entityType: "invoice" },
    });
    expect(after).toBe(before);
  });

  it("sets contact_id to NULL when the contact is hard-deleted (ON DELETE SET NULL)", async () => {
    const contact = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId,
        name: "Doomed Contact",
        createdBy: membersByRole.get("owner")!.id,
      },
    });
    const invoice = await createInvoice({ contactId: contact.id }).expect(201);
    expect(invoice.body.contactId).toBe(contact.id);

    await owner.contact.delete({ where: { id: contact.id } });

    const fetched = await request(app.getHttpServer())
      .get(`${baseUrl()}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(fetched.body.contactId).toBeNull();
  });

  it("org permission override grants sales invoices:write and revokes finance", async () => {
    // Replace the org's mapping: owner keeps everything, sales gains
    // invoices:read/write, finance is NOT granted invoices:write.
    const grants = [
      ...["customers:read", "customers:write", "permissions:read", "permissions:manage"].map(
        (permissionKey) => ({ roleKey: "owner", permissionKey }),
      ),
      { roleKey: "owner", permissionKey: "invoices:read" },
      { roleKey: "owner", permissionKey: "invoices:write" },
      { roleKey: "finance", permissionKey: "invoices:read" },
      { roleKey: "sales", permissionKey: "invoices:read" },
      { roleKey: "sales", permissionKey: "invoices:write" },
    ];
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants })
      .expect(200);

    await createInvoice({}, "sales").expect(201);
    await createInvoice({}, "finance").expect(403);

    // Reset to the BRD default matrix for the remaining tests.
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants: [] })
      .expect(200);
  });
});

describe("Invoices: state machine (BRD 4.1 — the only status code path)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  let financeToken: string;
  let ownerMember: FixtureUser;

  const baseUrl = () => `/organisations/${org.id}/customers/${customerId}/invoices`;

  async function createDraft(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `SM-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 5000,
        dueDate: orgDate(30),
      })
      .expect(201);
    return response.body.id;
  }

  function transition(id: string, action: string): request.Test {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${id}/${action}`)
      .set("Authorization", `Bearer ${financeToken}`);
  }

  async function statusOf(id: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`${baseUrl()}/${id}`)
      .set("Authorization", `Bearer ${financeToken}`)
      .expect(200);
    return response.body.status;
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "invoices-sm", ["owner", "finance"]);
    ownerMember = org.members.find((m) => m.roleKey === "owner")!;
    financeToken = await signToken({
      sub: org.members.find((m) => m.roleKey === "finance")!.authUserId,
      email: org.members.find((m) => m.roleKey === "finance")!.email,
    });
    customerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "State Machine Customer",
          createdBy: ownerMember.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("Draft → Active (activate) succeeds and audits from/to", async () => {
    const id = await createDraft();
    const response = await transition(id, "activate").expect(200);
    expect(response.body.status).toBe("active");

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: id, action: "invoice.status_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.metadata).toMatchObject({ from: "draft", to: "active" });
  });

  it("Draft → Cancelled (cancel) succeeds", async () => {
    const id = await createDraft();
    await transition(id, "cancel").expect(200);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("Active → Paused (pause) succeeds", async () => {
    const id = await createDraft();
    await transition(id, "activate").expect(200);
    await transition(id, "pause").expect(200);
    expect(await statusOf(id)).toBe("paused");
  });

  it("Paused → Active (resume) succeeds", async () => {
    const id = await createDraft();
    await transition(id, "activate").expect(200);
    await transition(id, "pause").expect(200);
    await transition(id, "resume").expect(200);
    expect(await statusOf(id)).toBe("active");
  });

  it("Active → Cancelled (cancel) succeeds", async () => {
    const id = await createDraft();
    await transition(id, "activate").expect(200);
    await transition(id, "cancel").expect(200);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("Paused → Cancelled (cancel) succeeds", async () => {
    const id = await createDraft();
    await transition(id, "activate").expect(200);
    await transition(id, "pause").expect(200);
    await transition(id, "cancel").expect(200);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("rejects every illegal transition → 409", async () => {
    // Draft: pause/resume are illegal.
    const draft = await createDraft();
    await transition(draft, "pause").expect(409);
    await transition(draft, "resume").expect(409);

    // Active: activate/resume are illegal.
    const active = await createDraft();
    await transition(active, "activate").expect(200);
    await transition(active, "activate").expect(409);
    await transition(active, "resume").expect(409);

    // Paused: pause is illegal.
    const paused = await createDraft();
    await transition(paused, "activate").expect(200);
    await transition(paused, "pause").expect(200);
    await transition(paused, "pause").expect(409);

    // Cancelled is terminal: nothing may leave it (reactivation included).
    const cancelled = await createDraft();
    await transition(cancelled, "cancel").expect(200);
    await transition(cancelled, "activate").expect(409);
    await transition(cancelled, "pause").expect(409);
    await transition(cancelled, "resume").expect(409);
    await transition(cancelled, "cancel").expect(409);
  });

  /**
   * ⚠️ `partially_paid` LEFT THIS LIST IN SLICE 1.6C, and deliberately.
   *
   * It was an outcome status with no API path, alongside paid and written_off.
   * Recording a payment made it a CHASED status — Eva is still collecting the
   * balance — so it must accept `pause` and `cancel` like any other invoice
   * being chased. Without that, taking a part payment would produce an invoice
   * nobody could ever stop.
   *
   * The rest genuinely have no path until slice 1.8. `paid` is terminal for a
   * different reason: it is reached only by money clearing the balance, and the
   * way out is a refund, which this product does not do.
   */
  it("outcome statuses have no API path (plan §7.3): seeded rows reject every action", async () => {
    for (const status of ["paid", "promise_to_pay", "disputed", "written_off"]) {
      const invoice = await owner.invoice.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          customerId,
          invoiceNumber: `OUT-${status}-${randomUUID().slice(0, 6)}`,
          amountMinorUnits: 100,
          issueDate: new Date(orgDate(-30)),
          dueDate: new Date(orgDate(-2)),
          status,
          createdBy: ownerMember.id,
        },
      });
      for (const action of ["activate", "pause", "resume", "cancel"]) {
        await transition(invoice.id, action).expect(409);
      }
      // And the stored status is untouched.
      const row = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(row.status).toBe(status);
    }
  });

  it("a part-paid invoice CAN be paused and cancelled, because it is still being chased", async () => {
    // The other half of the rule above: `partially_paid` gained a path in 1.6c
    // precisely so a part-paid invoice is not stranded beyond anyone's control.
    const invoice = await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId,
        invoiceNumber: `PART-${randomUUID().slice(0, 6)}`,
        amountMinorUnits: 1000,
        amountPaidMinorUnits: 400,
        issueDate: new Date(orgDate(-30)),
        dueDate: new Date(orgDate(-2)),
        status: "partially_paid",
        createdBy: ownerMember.id,
      },
    });
    await transition(invoice.id, "pause").expect(200);
    await transition(invoice.id, "resume").expect(200);
    await transition(invoice.id, "cancel").expect(200);
    // But it is not a draft, so it can never be activated.
    await transition(invoice.id, "activate").expect(409);
  });

  it("update schema is structurally status-free: no module file changes status outside the state machine", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const moduleDir = path.resolve(__dirname, "../src/products/invoice-follow-up/invoices");
    for (const file of readdirSync(moduleDir)) {
      if (!file.endsWith(".ts") || file === "invoice-state-machine.ts") continue;
      const source = readFileSync(path.join(moduleDir, file), "utf8");
      /**
       * The state machine is the ONLY code path allowed to write `status`.
       *
       * ⚠️ The scan must stay INSIDE one `invoice.update(...)` call. It used to
       * be `/invoice\.update\([\s\S]*?status\s*:/`, which crosses statement
       * boundaries: any `status:` ANYWHERE later in the file matched, however
       * unrelated. Adding an explicit `status: invoice.status` to the response
       * mapper — a read, not a write — was enough to fail it, and the obvious
       * way to "fix" that is to contort the product code to please the regex.
       *
       * `(?:(?!\}\))[\s\S])*?` stops at the first `})`, so the match cannot
       * escape the call it started in. Verified by mutation: adding
       * `data: { status: "paid" }` to an update in invoices.service.ts fails
       * this test, and removing it passes.
       */
      expect(source, `${file} must not write invoice.status`).not.toMatch(
        /invoice\.update\((?:(?!\}\))[\s\S])*?status\s*:/,
      );
    }
    // And the update request schema has no status key at all.
    const { updateInvoiceRequestSchema } = await import("@eva/validation");
    expect(Object.keys(updateInvoiceRequestSchema.shape)).not.toContain("status");
  });
});

describe("Invoices: computed statuses (plan §7.1 — derived at read time)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  let financeToken: string;
  let readToken: string;

  const baseUrl = () => `/organisations/${org.id}/customers/${customerId}/invoices`;

  async function createActive(dueDate: string): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `CS-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 7500,
        dueDate,
        status: "active",
      })
      .expect(201);
    return response.body;
  }

  async function displayStatusOf(id: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`${baseUrl()}/${id}`)
      .set("Authorization", `Bearer ${readToken}`)
      .expect(200);
    return response.body.displayStatus;
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "invoices-cs", ["owner", "finance", "read_only"]);
    const finance = org.members.find((m) => m.roleKey === "finance")!;
    const reader = org.members.find((m) => m.roleKey === "read_only")!;
    financeToken = await signToken({ sub: finance.authUserId, email: finance.email });
    readToken = await signToken({ sub: reader.authUserId, email: reader.email });
    customerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Computed Status Customer",
          createdBy: org.members[0]!.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("due within 3 days → due_soon; the 3/4-day boundary is exact", async () => {
    expect(await displayStatusOf((await createActive(orgDate(3))).id)).toBe("due_soon");
    expect(await displayStatusOf((await createActive(orgDate(1))).id)).toBe("due_soon");
    expect(await displayStatusOf((await createActive(orgDate(4))).id)).toBe("active");
  });

  it("due today → due_today; due yesterday → overdue", async () => {
    expect(await displayStatusOf((await createActive(orgDate(0))).id)).toBe("due_today");
    expect(await displayStatusOf((await createActive(orgDate(-1))).id)).toBe("overdue");
  });

  it("derivation never applies to non-Active invoices", async () => {
    // Paused invoice, overdue by date: stays "paused".
    const paused = await createActive(orgDate(-5));
    await request(app.getHttpServer())
      .post(`${baseUrl()}/${paused.id}/pause`)
      .set("Authorization", `Bearer ${financeToken}`)
      .expect(200);
    expect(await displayStatusOf(paused.id)).toBe("paused");

    // Draft invoice, overdue by date: stays "draft".
    const draft = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `CS-DRAFT-${randomUUID().slice(0, 6)}`,
        amountMinorUnits: 100,
        dueDate: orgDate(-5),
      })
      .expect(201);
    expect(draft.body.displayStatus).toBe("draft");

    // Cancelled invoice: stays "cancelled".
    const cancelled = await createActive(orgDate(-5));
    await request(app.getHttpServer())
      .post(`${baseUrl()}/${cancelled.id}/cancel`)
      .set("Authorization", `Bearer ${financeToken}`)
      .expect(200);
    expect(await displayStatusOf(cancelled.id)).toBe("cancelled");
  });

  it("list filter matches computed statuses", async () => {
    const overdue = await createActive(orgDate(-2));
    const response = await request(app.getHttpServer())
      .get(`${baseUrl()}?status=overdue`)
      .set("Authorization", `Bearer ${readToken}`)
      .expect(200);
    expect(response.body.length).toBeGreaterThan(0);
    expect(
      response.body.every((i: { displayStatus: string }) => i.displayStatus === "overdue"),
    ).toBe(true);
    expect(response.body.some((i: { id: string }) => i.id === overdue.id)).toBe(true);
  });

  it("respects a non-default organisation timezone", async () => {
    // Sydney is UTC+10/+11: pick the invoice due date that is "tomorrow" in
    // Europe/London but could already be "today+1" there — assert via the pure
    // function contract instead: an org set to Australia/Sydney derives
    // against Sydney's calendar day. Due "today in Sydney" must read due_today.
    const sydneyOrg = await createOrgWithMembers(owner, "invoices-syd", ["owner", "finance"]);
    await owner.organisationSettings.update({
      where: { organisationId: sydneyOrg.id },
      data: { timezone: "Australia/Sydney" },
    });
    const sydneyFinance = sydneyOrg.members.find((m) => m.roleKey === "finance")!;
    const sydneyToken = await signToken({
      sub: sydneyFinance.authUserId,
      email: sydneyFinance.email,
    });
    const sydneyCustomer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: sydneyOrg.id,
        name: "Sydney Customer",
        createdBy: sydneyOrg.members[0]!.id,
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/organisations/${sydneyOrg.id}/customers/${sydneyCustomer.id}/invoices`)
      .set("Authorization", `Bearer ${sydneyToken}`)
      .send({
        invoiceNumber: `SYD-${randomUUID().slice(0, 6)}`,
        amountMinorUnits: 100,
        dueDate: orgDate(0, "Australia/Sydney"),
        status: "active",
      })
      .expect(201);
    expect(response.body.displayStatus).toBe("due_today");
    expect(response.body.issueDate.slice(0, 10)).toBe(orgDate(0, "Australia/Sydney"));
  });
});

describe("Invoices: due-date derivation unit boundaries (BRD 13 — DST)", () => {
  // The pure derivation function is exercised with fixed `now` values so DST
  // boundaries are deterministic regardless of when the suite runs.
  it("derives against the org calendar day at the BST start (2026-03-29)", async () => {
    const { deriveDisplayStatus } =
      await import("../src/products/invoice-follow-up/invoices/invoice-status.js");
    // 2026-03-29 00:30 UTC = 00:30 Europe/London (still GMT) — today is the 29th.
    const now = new Date("2026-03-29T00:30:00Z");
    const due = (day: string) => ({ status: "active", dueDate: new Date(`${day}T00:00:00Z`) });
    expect(deriveDisplayStatus(due("2026-03-29"), "Europe/London", now)).toBe("due_today");
    expect(deriveDisplayStatus(due("2026-03-28"), "Europe/London", now)).toBe("overdue");
    expect(deriveDisplayStatus(due("2026-04-01"), "Europe/London", now)).toBe("due_soon");
    expect(deriveDisplayStatus(due("2026-04-02"), "Europe/London", now)).toBe("active");
  });

  it("derives against the org calendar day at the GMT return (2026-10-25)", async () => {
    const { deriveDisplayStatus } =
      await import("../src/products/invoice-follow-up/invoices/invoice-status.js");
    // 2026-10-25 00:30 UTC = 01:30 Europe/London (still BST) — today is the 25th.
    const now = new Date("2026-10-25T00:30:00Z");
    const due = (day: string) => ({ status: "active", dueDate: new Date(`${day}T00:00:00Z`) });
    expect(deriveDisplayStatus(due("2026-10-25"), "Europe/London", now)).toBe("due_today");
    expect(deriveDisplayStatus(due("2026-10-24"), "Europe/London", now)).toBe("overdue");
    expect(deriveDisplayStatus(due("2026-10-28"), "Europe/London", now)).toBe("due_soon");
    expect(deriveDisplayStatus(due("2026-10-29"), "Europe/London", now)).toBe("active");
  });

  it("a UTC instant can be different calendar days in different org timezones", async () => {
    const { deriveDisplayStatus } =
      await import("../src/products/invoice-follow-up/invoices/invoice-status.js");
    // 2026-07-01 05:00 UTC: still 2026-07-01 in London, already 2026-07-01 15:00
    // in Sydney (same day), but 2026-06-30 22:00 in Los Angeles (previous day).
    const now = new Date("2026-07-01T05:00:00Z");
    const invoice = { status: "active", dueDate: new Date("2026-07-01T00:00:00Z") };
    expect(deriveDisplayStatus(invoice, "Europe/London", now)).toBe("due_today");
    expect(deriveDisplayStatus(invoice, "America/Los_Angeles", now)).toBe("due_soon");
    expect(deriveDisplayStatus(invoice, "Australia/Sydney", now)).toBe("due_today");
  });

  it("never derives for non-Active statuses", async () => {
    const { deriveDisplayStatus } =
      await import("../src/products/invoice-follow-up/invoices/invoice-status.js");
    const now = new Date("2026-07-25T12:00:00Z");
    const overdue = new Date("2026-07-01T00:00:00Z");
    for (const status of ["draft", "paused", "cancelled", "paid", "disputed"]) {
      expect(deriveDisplayStatus({ status, dueDate: overdue }, "Europe/London", now)).toBe(status);
    }
  });
});

describe("Invoices: reminder scheduling hooks (Slice 1.5 — plan §3 recompute triggers)", () => {
  // The 1.2 PATCH is Draft-only (requireDraft), so no API path can change the
  // due_date of an ACTIVE invoice — the plan §3 "due-date edit" recompute
  // trigger has no live path to hook. What IS guaranteed here: a due-date
  // edit before activation is honoured by schedule-at-activation.
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  let financeMember: FixtureUser;
  let financeToken: string;

  const DAY_MS = 86_400_000;
  const baseUrl = () => `/organisations/${org.id}/customers/${customerId}/invoices`;

  /** The six BRD 4.1 default stages (order-independent assertions). */
  const DEFAULT_STEPS: Record<string, { offsetDays: number; actionType: string }> = {
    pre_due_3: { offsetDays: -3, actionType: "email" },
    due_date: { offsetDays: 0, actionType: "email" },
    overdue_7: { offsetDays: 7, actionType: "email" },
    overdue_14: { offsetDays: 14, actionType: "email" },
    overdue_30: { offsetDays: 30, actionType: "email" },
    final_escalation: { offsetDays: 37, actionType: "internal_escalation" },
  };

  interface ScheduledRow {
    id: string;
    organisationId: string;
    status: string;
    actionType: string;
    scheduledDate: Date;
    createdBy: string | null;
    reminderStep: { key: string; offsetDays: number };
  }

  /** YYYY-MM-DD of a UTC-midnight @db.Date value. */
  function ymd(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  /** Fresh contact per invoice so the 3-day per-contact spacing never interferes. */
  async function createContact(email: string | null): Promise<string> {
    const contact = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId,
        name: "Hook Contact",
        email,
        createdBy: financeMember.id,
      },
    });
    return contact.id;
  }

  async function createDraft(
    options: { contactId?: string; dueDate?: string } = {},
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `HOOK-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 5000,
        dueDate: options.dueDate ?? orgDate(14),
        ...(options.contactId !== undefined ? { contactId: options.contactId } : {}),
      })
      .expect(201);
    return response.body.id;
  }

  function transition(id: string, action: string): request.Test {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${id}/${action}`)
      .set("Authorization", `Bearer ${financeToken}`);
  }

  async function actionsOf(invoiceId: string): Promise<ScheduledRow[]> {
    return owner.scheduledAction.findMany({
      where: { invoiceId },
      include: { reminderStep: { select: { key: true, offsetDays: true } } },
      orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }],
    });
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "invoices-hooks", ["owner", "finance"]);
    financeMember = org.members.find((m) => m.roleKey === "finance")!;
    financeToken = await signToken({ sub: financeMember.authUserId, email: financeMember.email });
    customerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Reminder Hooks Customer",
          createdBy: org.members.find((m) => m.roleKey === "owner")!.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("activate schedules all six default steps at due-date offsets (future due → all pending)", async () => {
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const dueDate = orgDate(14);
    const id = await createDraft({ contactId, dueDate });
    await transition(id, "activate").expect(200);

    const rows = await actionsOf(id);
    expect(rows).toHaveLength(6);
    const dueMs = new Date(dueDate).getTime();
    for (const row of rows) {
      const spec = DEFAULT_STEPS[row.reminderStep.key];
      expect(spec, `unexpected step '${row.reminderStep.key}'`).toBeDefined();
      expect(row.scheduledDate.getTime()).toBe(dueMs + spec!.offsetDays * DAY_MS);
      expect(row.status).toBe("pending");
      expect(row.actionType).toBe(spec!.actionType);
      expect(row.organisationId).toBe(org.id);
      expect(row.createdBy).toBe(financeMember.id);
    }
  });

  it("activate marks a today-due row ready and future rows pending", async () => {
    // Due in 3 days: pre_due_3 lands exactly today; every other step is ≥3
    // days further out, so per-contact spacing never defers anything.
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const dueDate = orgDate(3);
    const id = await createDraft({ contactId, dueDate });
    await transition(id, "activate").expect(200);

    const rows = await actionsOf(id);
    expect(rows).toHaveLength(6);
    const byKey = new Map(rows.map((row) => [row.reminderStep.key, row]));
    expect(ymd(byKey.get("pre_due_3")!.scheduledDate)).toBe(orgDate(0));
    expect(byKey.get("pre_due_3")!.status).toBe("ready");
    const dueMs = new Date(dueDate).getTime();
    for (const key of ["due_date", "overdue_7", "overdue_14", "overdue_30", "final_escalation"]) {
      const row = byKey.get(key)!;
      expect(row.status).toBe("pending");
      expect(row.scheduledDate.getTime()).toBe(dueMs + row.reminderStep.offsetDays * DAY_MS);
    }
  });

  it("activate of an overdue invoice collapses missed steps: only the latest, for today", async () => {
    // Due 5 days ago: pre_due_3 (−8) and due_date (−5) are both missed — only
    // the latest (due_date) survives, scheduled for today as ready; the
    // earlier missed step gets NO row (plan §3 catch-up collapse).
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const id = await createDraft({ contactId, dueDate: orgDate(-5) });
    await transition(id, "activate").expect(200);

    const rows = await actionsOf(id);
    const byKey = new Map(rows.map((row) => [row.reminderStep.key, row]));
    expect(byKey.has("pre_due_3")).toBe(false);
    expect(rows).toHaveLength(5);
    const collapsed = byKey.get("due_date")!;
    expect(ymd(collapsed.scheduledDate)).toBe(orgDate(0));
    expect(collapsed.status).toBe("ready");
    for (const key of ["overdue_7", "overdue_14", "overdue_30", "final_escalation"]) {
      const row = byKey.get(key)!;
      expect(row.status).toBe("pending");
      expect(row.scheduledDate.getTime()).toBeGreaterThan(collapsed.scheduledDate.getTime());
    }
  });

  it("a repeated activate is a 409 and never duplicates scheduled rows", async () => {
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const id = await createDraft({ contactId });
    await transition(id, "activate").expect(200);
    await transition(id, "activate").expect(409);

    const rows = await actionsOf(id);
    expect(rows).toHaveLength(6);
    const slots = new Set(rows.map((row) => `${row.reminderStep.key}:${ymd(row.scheduledDate)}`));
    expect(slots.size).toBe(6);
  });

  it("activate of ineligible invoices (no email / deleted contact / suppressed) schedules nothing", async () => {
    // Contact without an email.
    const noEmail = await createDraft({ contactId: await createContact(null) });
    await transition(noEmail, "activate").expect(200);
    expect(await actionsOf(noEmail)).toHaveLength(0);

    // Contact soft-deleted after the draft was created (link stays — the 1.4 observation).
    const deletedContactId = await createContact(
      `hook-del-${randomUUID().slice(0, 8)}@example.test`,
    );
    const deletedContact = await createDraft({ contactId: deletedContactId });
    await owner.contact.update({
      where: { id: deletedContactId },
      data: { deletedAt: new Date() },
    });
    await transition(deletedContact, "activate").expect(200);
    expect(await actionsOf(deletedContact)).toHaveLength(0);

    // Contact email on the permanent suppression list.
    const suppressedEmail = `hook-sup-${randomUUID().slice(0, 8)}@example.test`;
    await owner.suppressionEvent.create({
      data: { organisationId: org.id, channel: "email", value: suppressedEmail },
    });
    const suppressed = await createDraft({ contactId: await createContact(suppressedEmail) });
    await transition(suppressed, "activate").expect(200);
    expect(await actionsOf(suppressed)).toHaveLength(0);

    // Eligibility never blocks the state machine — all three still activated.
    for (const id of [noEmail, deletedContact, suppressed]) {
      const invoice = await owner.invoice.findUniqueOrThrow({ where: { id } });
      expect(invoice.status).toBe("active");
    }
  });

  it("pause cancels live rows; resume recomputes fresh rows; cancel leaves zero live", async () => {
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const id = await createDraft({ contactId });
    await transition(id, "activate").expect(200);
    const first = await actionsOf(id);
    expect(first).toHaveLength(6);

    await transition(id, "pause").expect(200);
    const afterPause = await actionsOf(id);
    expect(afterPause).toHaveLength(6);
    expect(afterPause.every((row) => row.status === "cancelled")).toBe(true);

    const pauseAudit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: id, action: "reminder_action.cancelled" },
      orderBy: { createdAt: "desc" },
    });
    expect(pauseAudit?.actorUserId).toBe(financeMember.id);
    expect(pauseAudit?.metadata).toMatchObject({ cancelledCount: 6, reason: "invoice_paused" });

    await transition(id, "resume").expect(200);
    const afterResume = await actionsOf(id);
    expect(afterResume).toHaveLength(12);
    const firstIds = new Set(first.map((row) => row.id));
    const live = afterResume.filter((row) => row.status !== "cancelled");
    // Migration 0011 semantics: fresh rows with new ids; cancelled stays history.
    expect(live).toHaveLength(6);
    expect(live.every((row) => !firstIds.has(row.id))).toBe(true);
    expect(afterResume.filter((row) => row.status === "cancelled")).toHaveLength(6);

    await transition(id, "cancel").expect(200);
    const afterCancel = await actionsOf(id);
    expect(afterCancel).toHaveLength(12);
    expect(afterCancel.every((row) => row.status === "cancelled")).toBe(true);
  });

  it("a due-date edit before activation is honoured: the schedule follows the NEW due date", async () => {
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const id = await createDraft({ contactId, dueDate: orgDate(10) });
    await request(app.getHttpServer())
      .patch(`${baseUrl()}/${id}`)
      .set("Authorization", `Bearer ${financeToken}`)
      .send({ dueDate: orgDate(30) })
      .expect(200);
    await transition(id, "activate").expect(200);

    const rows = await actionsOf(id);
    expect(rows).toHaveLength(6);
    const dueMs = new Date(orgDate(30)).getTime();
    for (const row of rows) {
      expect(row.scheduledDate.getTime()).toBe(dueMs + row.reminderStep.offsetDays * DAY_MS);
    }
  });

  it("a scheduling failure rolls the activation back (invoice stays Draft, no actions, no audit)", async () => {
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const id = await createDraft({ contactId });
    reminderActionsMock.failScheduling = true;
    try {
      await transition(id, "activate").expect(500);
    } finally {
      reminderActionsMock.failScheduling = false;
    }

    const invoice = await owner.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe("draft");
    expect(await actionsOf(id)).toHaveLength(0);
    expect(
      await owner.auditLog.count({
        where: {
          entityId: id,
          action: { in: ["invoice.status_changed", "reminder_action.scheduled"] },
        },
      }),
    ).toBe(0);

    // The invoice recovers cleanly: a retry activates and schedules normally.
    await transition(id, "activate").expect(200);
    expect(await actionsOf(id)).toHaveLength(6);
  });

  it("reminder scheduling is audited with the acting user's id, after the status audit", async () => {
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const id = await createDraft({ contactId });
    await transition(id, "activate").expect(200);

    const scheduledAudit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: id, action: "reminder_action.scheduled" },
    });
    expect(scheduledAudit?.actorUserId).toBe(financeMember.id);
    expect(scheduledAudit?.entityType).toBe("invoice");
    expect(scheduledAudit?.metadata).toMatchObject({ scheduledCount: 6 });

    // The existing invoice audit assertions are untouched: status_changed is
    // still written, ordered before the reminder side-effect audit.
    const statusAudit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: id, action: "invoice.status_changed" },
    });
    expect(statusAudit?.metadata).toMatchObject({ from: "draft", to: "active" });
    expect(statusAudit!.createdAt.getTime()).toBeLessThanOrEqual(
      scheduledAudit!.createdAt.getTime(),
    );
  });

  it("create-as-active schedules immediately; ineligible contact → zero rows; draft → zero rows", async () => {
    // An already-sent invoice created directly as Active gets the same
    // schedule a Draft→Active activation would produce.
    const contactId = await createContact(`hook-${randomUUID().slice(0, 8)}@example.test`);
    const dueDate = orgDate(14);
    const active = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `HOOK-ACT-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 5000,
        dueDate,
        contactId,
        status: "active",
      })
      .expect(201);
    expect(active.body.status).toBe("active");

    const rows = await actionsOf(active.body.id);
    expect(rows).toHaveLength(6);
    const dueMs = new Date(dueDate).getTime();
    for (const row of rows) {
      const spec = DEFAULT_STEPS[row.reminderStep.key];
      expect(spec, `unexpected step '${row.reminderStep.key}'`).toBeDefined();
      expect(row.scheduledDate.getTime()).toBe(dueMs + spec!.offsetDays * DAY_MS);
      expect(row.status).toBe("pending");
      expect(row.createdBy).toBe(financeMember.id);
    }

    // Ineligible contact: the invoice is still created Active, schedule empty.
    const ineligible = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${financeToken}`)
      .send({
        invoiceNumber: `HOOK-INEL-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 5000,
        dueDate: orgDate(14),
        contactId: await createContact(null),
        status: "active",
      })
      .expect(201);
    expect(ineligible.body.status).toBe("active");
    expect(await actionsOf(ineligible.body.id)).toHaveLength(0);

    // Draft creates stay unscheduled.
    const draftId = await createDraft({ contactId });
    expect(await actionsOf(draftId)).toHaveLength(0);
  });
});

/**
 * The organisation's whole book — `GET /organisations/:id/invoices`
 * (slice 1.6c, task 9: the founder's one table).
 *
 * Until this existed, invoices were reachable only through a client, so the
 * first question a credit controller asks — "what is overdue right now?" —
 * could only be answered by opening clients one at a time.
 */
describe("Invoices: the organisation-wide book", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerA: string;
  let customerB: string;
  let token: string;
  let readOnlyToken: string;

  const url = () => `/organisations/${org.id}/invoices`;

  /** Seeded directly: this suite is about READING a book, not building one. */
  async function seedInvoice(input: {
    customerId: string;
    number: string;
    amount: number;
    paid?: number;
    currency?: string;
    dueOffset: number;
    status?: string;
  }) {
    return owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: input.customerId,
        invoiceNumber: input.number,
        amountMinorUnits: input.amount,
        amountPaidMinorUnits: input.paid ?? 0,
        currency: input.currency ?? "GBP",
        issueDate: new Date(orgDate(-60)),
        dueDate: new Date(orgDate(input.dueOffset)),
        status: input.status ?? "active",
        createdBy: org.members[0]!.id,
      },
    });
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "book", ["owner", "read_only"]);
    token = await signToken({
      sub: org.members[0]!.authUserId,
      email: org.members[0]!.email,
    });
    const readOnly = org.members.find((m) => m.roleKey === "read_only")!;
    readOnlyToken = await signToken({ sub: readOnly.authUserId, email: readOnly.email });

    customerA = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Alpha Trading",
          createdBy: org.members[0]!.id,
        },
      })
    ).id;
    customerB = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Beta Works",
          createdBy: org.members[0]!.id,
        },
      })
    ).id;

    // A deliberately awkward book: two clients, three currencies, every ageing
    // bucket, an overpayment, and rows that must NOT be counted as owed.
    await seedInvoice({
      customerId: customerA,
      number: "BK-CURRENT",
      amount: 10_000,
      dueOffset: 5,
    });
    await seedInvoice({ customerId: customerA, number: "BK-TODAY", amount: 20_000, dueOffset: 0 });
    await seedInvoice({ customerId: customerA, number: "BK-OD10", amount: 30_000, dueOffset: -10 });
    await seedInvoice({ customerId: customerB, number: "BK-OD20", amount: 40_000, dueOffset: -20 });
    await seedInvoice({ customerId: customerB, number: "BK-OD40", amount: 50_000, dueOffset: -40 });
    await seedInvoice({ customerId: customerB, number: "BK-OD99", amount: 60_000, dueOffset: -99 });
    await seedInvoice({
      customerId: customerB,
      number: "BK-AED",
      amount: 100_000,
      currency: "AED",
      dueOffset: -3,
    });
    // Overpaid: the clamp must stop this eating 2,500 off the AED total.
    await seedInvoice({
      customerId: customerB,
      number: "BK-AED-OVER",
      amount: 50_000,
      paid: 52_500,
      currency: "AED",
      dueOffset: -3,
      status: "paid",
    });
    // Not chased — must appear as a ROW but never in the money.
    await seedInvoice({
      customerId: customerA,
      number: "BK-CANCELLED",
      amount: 99_000,
      dueOffset: -30,
      status: "cancelled",
    });
    await seedInvoice({
      customerId: customerA,
      number: "BK-DRAFT",
      amount: 88_000,
      dueOffset: -30,
      status: "draft",
    });
    /* Paused: NOT chased and absolutely still owed. The one row that tells the
       two lists apart — without it, "owed" and "chased" return the same number
       and the difference between them is untested. */
    await seedInvoice({
      customerId: customerA,
      number: "BK-PAUSED",
      amount: 70_000,
      dueOffset: -30,
      status: "paused",
    });
    // Part paid: chased, and only the BALANCE counts.
    await seedInvoice({
      customerId: customerA,
      number: "BK-PART",
      amount: 100_000,
      paid: 60_000,
      dueOffset: -5,
      status: "partially_paid",
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  function book(query = "", auth = token) {
    return request(app.getHttpServer())
      .get(`${url()}${query}`)
      .set("Authorization", `Bearer ${auth}`);
  }

  it("returns invoices across EVERY client, most overdue first", async () => {
    const response = await book().expect(200);
    const numbers = response.body.rows.map((row: { invoiceNumber: string }) => row.invoiceNumber);
    expect(numbers).toContain("BK-OD99");
    expect(numbers).toContain("BK-AED");
    // Both clients, which is the whole reason this endpoint exists.
    const clients = new Set(
      response.body.rows.map((row: { customer: { name: string } }) => row.customer.name),
    );
    expect(clients).toEqual(new Set(["Alpha Trading", "Beta Works"]));
    // Oldest due date first: the top of the screen is what needs doing today.
    expect(numbers[0]).toBe("BK-OD99");
  });

  it("carries the client and the reminder recipient on every row", async () => {
    const response = await book("?search=BK-OD99").expect(200);
    const row = response.body.rows[0];
    expect(row.customer).toMatchObject({ name: "Beta Works" });
    // No contact on these fixtures, so it is null rather than absent — the
    // screen shows "nobody to email", which is a real state.
    expect(row.contact).toBeNull();
    expect(row.chaseBlockedReason).toBe("no_contact");
  });

  /**
   * ⚠️ THE PAGING TRAP. `overdue` is derived per request from the org timezone
   * and is deliberately not a column, so the obvious implementation filters in
   * memory — which, with paging, asks the database for fifty rows and shows
   * nine, with a total that disagrees with the page. The filter is a due-date
   * range instead.
   */
  it("filters on a COMPUTED status in the database, so paging stays honest", async () => {
    const response = await book("?status=overdue&limit=3").expect(200);
    expect(response.body.rows).toHaveLength(3);
    // Every returned row really is overdue...
    for (const row of response.body.rows) {
      expect(row.displayStatus).toBe("overdue");
    }
    // ...and the count is of everything matching, not of the page.
    expect(response.body.totalCount).toBeGreaterThan(3);

    const all = await book("?status=overdue&limit=200").expect(200);
    expect(all.body.rows).toHaveLength(all.body.totalCount);
  });

  it("never counts an unchased invoice as overdue, however old", async () => {
    // BK-CANCELLED and BK-DRAFT are both 30 days past their due date.
    const response = await book("?status=overdue&limit=200").expect(200);
    const numbers = response.body.rows.map((row: { invoiceNumber: string }) => row.invoiceNumber);
    expect(numbers).not.toContain("BK-CANCELLED");
    expect(numbers).not.toContain("BK-DRAFT");
  });

  it("filters due_today and due_soon without catching each other", async () => {
    const today = await book("?status=due_today").expect(200);
    expect(today.body.rows.map((r: { invoiceNumber: string }) => r.invoiceNumber)).toEqual([
      "BK-TODAY",
    ]);
    const soon = await book("?status=due_soon").expect(200);
    const soonNumbers = soon.body.rows.map((r: { invoiceNumber: string }) => r.invoiceNumber);
    // Due in 5 days is NOT "soon" (the stage is 3), and today is its own state.
    expect(soonNumbers).not.toContain("BK-TODAY");
    expect(soonNumbers).not.toContain("BK-CURRENT");
  });

  it("puts each invoice in its ageing bucket, derived from the due date", async () => {
    const response = await book("?limit=200").expect(200);
    const bucketOf = (number: string) =>
      response.body.rows.find((r: { invoiceNumber: string }) => r.invoiceNumber === number)
        ?.ageingBucket;
    expect(bucketOf("BK-CURRENT")).toBe("current");
    // Due today is NOT late — the money is not overdue until the day is out.
    expect(bucketOf("BK-TODAY")).toBe("current");
    expect(bucketOf("BK-OD10")).toBe("days_1_15");
    expect(bucketOf("BK-OD20")).toBe("days_16_30");
    expect(bucketOf("BK-OD40")).toBe("days_31_45");
    expect(bucketOf("BK-OD99")).toBe("days_over_45");
  });

  describe("what the organisation is owed, per currency", () => {
    it("never adds one currency to another", async () => {
      const response = await book().expect(200);
      const codes = response.body.chasedByCurrency.map((c: { currency: string }) => c.currency);
      expect(codes).toEqual(["AED", "GBP"]);
    });

    /**
     * ⚠️ THIS DOES NOT PROVE THE CLAMP, AND IT USED TO SAY IT DID. Found by
     * mutation on 2026-08-09: deleting `GREATEST(..., 0)` left this test green.
     * BK-AED-OVER is the only overpaid row and its status is `paid`, so the
     * chased filter excludes it before the arithmetic is ever reached — the
     * clamp cannot change this number, whatever it does.
     *
     * What it actually proves is worth keeping: a settled invoice is not money
     * anybody is collecting, so it is absent from the chased total entirely.
     * The clamp is proved where an overpaid row really does reach the sum, in
     * "clamps an overpayment under a filter too" below.
     */
    it("leaves a settled invoice out of the chased money altogether", async () => {
      const response = await book().expect(200);
      const aed = response.body.chasedByCurrency.find(
        (c: { currency: string }) => c.currency === "AED",
      );
      // Only BK-AED is chased (BK-AED-OVER is paid), so exactly its full amount.
      expect(aed).toMatchObject({
        currency: "AED",
        invoiceCount: 1,
        outstandingMinorUnits: 100_000,
      });
    });

    it("counts the BALANCE of a part-paid invoice, not its total", async () => {
      const response = await book().expect(200);
      const gbp = response.body.chasedByCurrency.find(
        (c: { currency: string }) => c.currency === "GBP",
      );
      // 10,000 + 20,000 + 30,000 + 40,000 + 50,000 + 60,000 chased in full,
      // plus BK-PART's balance of 40,000. Cancelled and draft are excluded.
      expect(gbp.outstandingMinorUnits).toBe(250_000);
      expect(gbp.invoiceCount).toBe(7);
    });

    it("excludes cancelled and draft invoices from the money entirely", async () => {
      // They still appear as ROWS — nothing is hidden — but nobody is
      // collecting them, so putting them in a total makes "what am I owed"
      // wrong.
      const response = await book("?limit=200").expect(200);
      const numbers = response.body.rows.map((r: { invoiceNumber: string }) => r.invoiceNumber);
      expect(numbers).toContain("BK-CANCELLED");
      expect(numbers).toContain("BK-DRAFT");
      const gbp = response.body.chasedByCurrency.find(
        (c: { currency: string }) => c.currency === "GBP",
      );
      // Named explicitly rather than "less than": the total must be the chased
      // 250,000 and NOT that plus the cancelled 99,000 and the draft 88,000.
      expect(gbp.outstandingMinorUnits).toBe(250_000);
      expect(gbp.outstandingMinorUnits).not.toBe(250_000 + 99_000 + 88_000);
      // And the count is of chased invoices, not of the rows on screen.
      expect(gbp.invoiceCount).toBeLessThan(numbers.length);
    });

    /**
     * ⚠️ THE HALF OF THIS NOBODY CHECKED UNTIL PRODUCTION SAID IT OUT LOUD.
     * `matchedByCurrency` follows the caller's filters, which made it look safe
     * under every heading — but with NO filter it sweeps in the cancelled and
     * the draft, and that is the view the book screen opens on. On 2026-08-12
     * production read "£4,525.00 outstanding across 1 invoice" about a single
     * cancelled invoice.
     *
     * This test pins the behaviour that is CORRECT and dangerous, so that the
     * one below it has something to be different from.
     */
    it("still totals cancelled and draft money in matchedByCurrency when nothing is filtered", async () => {
      const response = await book("?limit=200").expect(200);
      const gbp = response.body.matchedByCurrency.find(
        (c: { currency: string }) => c.currency === "GBP",
      );
      expect(gbp.outstandingMinorUnits).toBe(250_000 + 99_000 + 88_000 + 70_000);
    });

    /**
     * ⚠️ THIS IS THE TOTAL THE WORD "OUTSTANDING" IS ALLOWED TO SIT ON, and the
     * only one. It follows the filters like `matched` — so it cannot disagree
     * with the list printed under it — and drops the states nobody is
     * collecting like `chased`, so the sentence above it stays true.
     */
    it("leaves cancelled and draft money out of collectableByCurrency", async () => {
      const response = await book("?limit=200").expect(200);
      const gbp = response.body.collectableByCurrency.find(
        (c: { currency: string }) => c.currency === "GBP",
      );
      expect(gbp.outstandingMinorUnits).toBe(250_000 + 70_000);
      expect(gbp.outstandingMinorUnits).not.toBe(250_000 + 99_000 + 88_000 + 70_000);
      expect(gbp.invoiceCount).toBe(8);
    });

    /**
     * ⚠️ THE OTHER DIRECTION, AND IT IS JUST AS WRONG. The first pass at this
     * fix narrowed the total to the CHASED statuses, which reads as the obvious
     * thing to do and quietly deletes every paused invoice from what the
     * business is owed. Eva not writing to a debtor this week does not mean the
     * debtor stopped owing.
     *
     * BK-PAUSED is the row that tells the two lists apart: absent from the
     * chased total, present in the owed one.
     */
    it("counts a PAUSED invoice as owed, though nobody is chasing it", async () => {
      const response = await book("?limit=200").expect(200);
      const gbpIn = (list: { currency: string; outstandingMinorUnits: number }[]) =>
        list.find((c) => c.currency === "GBP")?.outstandingMinorUnits;
      expect(gbpIn(response.body.chasedByCurrency)).toBe(250_000);
      expect(gbpIn(response.body.collectableByCurrency)).toBe(250_000 + 70_000);
      // And it is on screen as a row, so the money and the list agree.
      const numbers = response.body.rows.map((r: { invoiceNumber: string }) => r.invoiceNumber);
      expect(numbers).toContain("BK-PAUSED");
    });

    /**
     * And it must keep FOLLOWING the filter, or it has quietly become
     * `chasedByCurrency` — whole-book money above a narrowed list, which is the
     * disagreement this screen already fixed once.
     */
    it("narrows collectableByCurrency with the filter, unlike the whole-book total", async () => {
      const response = await book("?status=overdue&limit=200").expect(200);
      const collectable = response.body.collectableByCurrency.find(
        (c: { currency: string }) => c.currency === "GBP",
      );
      const chased = response.body.chasedByCurrency.find(
        (c: { currency: string }) => c.currency === "GBP",
      );
      expect(chased.outstandingMinorUnits).toBe(250_000);
      expect(collectable.outstandingMinorUnits).toBeLessThan(chased.outstandingMinorUnits);
    });
  });

  /**
   * The money the FILTERS selected, which is a different question from what the
   * organisation is chasing overall — and the reason the home screen could
   * previously only say how many invoices were overdue, never how much.
   */
  describe("the money the filters actually selected", () => {
    interface Total {
      currency: string;
      invoiceCount: number;
      outstandingMinorUnits: number;
    }
    const find = (rows: Total[], code: string) => rows.find((row) => row.currency === code);

    it("totals only what is overdue, not the whole book", async () => {
      const response = await book("?status=overdue&limit=200").expect(200);
      // BK-OD10/20/40/99 in full plus BK-PART's 40,000 BALANCE. NOT BK-CURRENT
      // or BK-TODAY (not late), and not the cancelled or draft rows (nobody is
      // collecting those) — 250,000 would be the whole book.
      expect(find(response.body.matchedByCurrency, "GBP")).toMatchObject({
        invoiceCount: 5,
        outstandingMinorUnits: 220_000,
      });
      expect(find(response.body.matchedByCurrency, "AED")).toMatchObject({
        invoiceCount: 1,
        outstandingMinorUnits: 100_000,
      });
    });

    /**
     * ⚠️ THE POINT OF THE WHOLE CHANGE, IN ONE ASSERTION. If these two ever
     * report the same GBP figure under an overdue filter, the filtered total
     * has silently gone back to being the unfiltered one.
     */
    it("differs from the unfiltered total, which stays whole-book", async () => {
      const response = await book("?status=overdue&limit=200").expect(200);
      expect(find(response.body.matchedByCurrency, "GBP")!.outstandingMinorUnits).toBe(220_000);
      expect(find(response.body.chasedByCurrency, "GBP")!.outstandingMinorUnits).toBe(250_000);
    });

    /**
     * ⚠️ THE CURRENCY PICKER IS BUILT FROM `chasedByCurrency`, AND FILTERING IT
     * WOULD HIDE MONEY. Looking at GBP must still tell a customer there is AED
     * on the book — collapsing the list to the currency already chosen is the
     * exact failure the picker exists to prevent.
     */
    it("narrows by currency without narrowing the list of currencies", async () => {
      const response = await book("?currency=GBP&limit=200").expect(200);
      expect(response.body.matchedByCurrency.map((r: { currency: string }) => r.currency)).toEqual([
        "GBP",
      ]);
      expect(response.body.chasedByCurrency.map((r: { currency: string }) => r.currency)).toEqual([
        "AED",
        "GBP",
      ]);
    });

    it("clamps an overpayment under a filter too", async () => {
      // BK-AED-OVER is paid 2,500 over. Asking for paid invoices must report
      // zero, never a negative that eats another invoice's balance.
      const response = await book("?status=paid&currency=AED&limit=200").expect(200);
      expect(find(response.body.matchedByCurrency, "AED")).toMatchObject({
        invoiceCount: 1,
        outstandingMinorUnits: 0,
      });
    });

    it("totals a state nobody is collecting when that is what was asked for", async () => {
      // Drafts are deliberately absent from `chasedByCurrency` — but a caller
      // that asks for drafts is owed the answer to the question it asked.
      const response = await book("?status=draft&limit=200").expect(200);
      expect(find(response.body.matchedByCurrency, "GBP")).toMatchObject({
        invoiceCount: 1,
        outstandingMinorUnits: 88_000,
      });
      expect(find(response.body.chasedByCurrency, "GBP")!.outstandingMinorUnits).toBe(250_000);
    });

    it("is empty when nothing matches, rather than falling back to the book", async () => {
      const response = await book("?search=nothing-matches-this").expect(200);
      expect(response.body.matchedByCurrency).toEqual([]);
      expect(response.body.totalCount).toBe(0);
      // The book itself is still there — an empty RESULT is not an empty book.
      expect(response.body.chasedByCurrency.length).toBeGreaterThan(0);
    });

    /**
     * ⚠️ THE DRIFT GUARD, AND THE REASON IT EXISTS.
     *
     * The rows and `totalCount` are filtered by Prisma; the money is filtered
     * by hand-written SQL, because the balance is clamped PER ROW and Prisma's
     * aggregate cannot express `GREATEST(amount - paid, 0)`. So the same
     * question is written twice, in two languages, and nothing about the type
     * system makes them agree — a filter added to one and forgotten in the
     * other would ship a screen whose money and whose count describe different
     * sets of invoices, which is precisely the bug this slice set out to fix.
     *
     * Counting is what makes it mechanical: a COUNT has no units, so summing it
     * across currencies is the one cross-currency arithmetic that is honest.
     *
     * ⚠️ `%` AND `_` ARE LIKE WILDCARDS AND ARE NOT ESCAPED BY EITHER SIDE.
     * They are in this list on purpose: a customer typing an underscore is the
     * cheapest way to find out that the two forms disagree about what a search
     * term means.
     */
    it("agrees with totalCount for every filter, so the two forms cannot drift", async () => {
      const queries = [
        "",
        "?status=overdue",
        "?status=due_today",
        "?status=due_soon",
        "?status=draft",
        "?status=cancelled",
        "?status=paid",
        "?status=active",
        "?currency=aed",
        "?currency=GBP",
        `?customerId=${customerA}`,
        `?customerId=${customerB}`,
        "?search=BK-OD",
        "?search=beta",
        `?search=${encodeURIComponent("BK_OD10")}`,
        `?search=${encodeURIComponent("100%")}`,
        "?status=overdue&currency=GBP",
        "?status=overdue&currency=AED",
        `?status=overdue&customerId=${customerB}&search=BK`,
        `?currency=GBP&customerId=${customerA}&search=bk-`,
      ];

      for (const query of queries) {
        const response = await book(`${query}${query ? "&" : "?"}limit=200`).expect(200);
        const counted = response.body.matchedByCurrency.reduce(
          (sum: number, row: { invoiceCount: number }) => sum + row.invoiceCount,
          0,
        );
        expect(
          counted,
          `matchedByCurrency and totalCount disagree for '${query || "(no filter)"}'`,
        ).toBe(response.body.totalCount);
        // And the page itself agrees, so neither has drifted from the rows.
        expect(
          response.body.rows.length,
          `rows and totalCount disagree for '${query || "(no filter)"}'`,
        ).toBe(response.body.totalCount);
      }
    });
  });

  it("filters by currency and by client", async () => {
    const aed = await book("?currency=aed").expect(200);
    for (const row of aed.body.rows) expect(row.currency).toBe("AED");
    const alpha = await book(`?customerId=${customerA}&limit=200`).expect(200);
    for (const row of alpha.body.rows) expect(row.customer.id).toBe(customerA);
  });

  it("searches invoice numbers and client names", async () => {
    const byNumber = await book("?search=BK-OD99").expect(200);
    expect(byNumber.body.rows).toHaveLength(1);
    const byClient = await book("?search=beta").expect(200);
    expect(byClient.body.rows.length).toBeGreaterThan(1);
    for (const row of byClient.body.rows) expect(row.customer.name).toBe("Beta Works");
  });

  it("pages, and caps a request that asks for the world", async () => {
    const first = await book("?limit=2&offset=0").expect(200);
    const second = await book("?limit=2&offset=2").expect(200);
    expect(first.body.rows).toHaveLength(2);
    const firstIds = first.body.rows.map((r: { id: string }) => r.id);
    const secondIds = second.body.rows.map((r: { id: string }) => r.id);
    expect(firstIds).not.toEqual(secondIds);
    // An unbounded read is a query that works here and takes a server down on a
    // real book.
    const huge = await book("?limit=100000").expect(200);
    expect(huge.body.rows.length).toBeLessThanOrEqual(200);
  });

  it("says when Eva is next due to chase, and stays silent about sends that have not happened", async () => {
    /**
     * ⚠️ `lastChasedOn` IS NULL FOR EVERYTHING UNTIL SLICE 1.7. Nothing sends
     * yet, so no scheduled_action ever reaches `sent`. The column exists now so
     * it fills in the day sending ships — a screen must not read the empty
     * value as "never chased".
     */
    const invoice = await seedInvoice({
      customerId: customerA,
      number: `BK-SCHED-${randomUUID().slice(0, 6)}`,
      amount: 1000,
      dueOffset: 3,
    });
    const step = await owner.reminderStep.findFirst({ where: { organisationId: org.id } });
    if (step) {
      await owner.scheduledAction.create({
        data: {
          organisationId: org.id,
          invoiceId: invoice.id,
          reminderStepId: step.id,
          actionType: "email",
          scheduledDate: new Date(orgDate(1)),
          status: "pending",
          idempotencyKey: randomUUID(),
        },
      });
      const response = await book(`?search=${invoice.invoiceNumber}`).expect(200);
      expect(response.body.rows[0].nextChaseOn).not.toBeNull();
      expect(response.body.rows[0].lastChasedOn).toBeNull();
    }
  });

  it("rejects an unknown status filter rather than silently returning everything", async () => {
    await book("?status=nonsense").expect(400);
  });

  /**
   * Adding a row by hand — client, contact and invoice in one act.
   *
   * ⚠️ THE CLIENT IS RESOLVED THE WAY THE IMPORTER RESOLVES IT. Typing a row
   * and uploading the same row must land in the same place, or one client
   * quietly becomes two.
   */
  describe("adding a row by typing it", () => {
    function addRow(body: Record<string, unknown>, auth = token) {
      return request(app.getHttpServer())
        .post(url())
        .set("Authorization", `Bearer ${auth}`)
        .send({
          clientName: `Typed Client ${randomUUID().slice(0, 6)}`,
          invoiceNumber: `TYPED-${randomUUID().slice(0, 8)}`,
          amountMinorUnits: 125_000,
          currency: "GBP",
          dueDate: orgDate(14),
          ...body,
        });
    }

    it("creates the client, the contact and the invoice together", async () => {
      const contactEmail = `ap-${randomUUID().slice(0, 8)}@typed.example`;
      const response = await addRow({
        clientName: "Brand New Client Ltd",
        contactName: "Ada Byron",
        contactEmail,
        contactPhone: "+447700900123",
      }).expect(201);

      expect(response.body.contactId).not.toBeNull();
      const customer = await owner.customer.findFirst({
        where: { organisationId: org.id, name: "Brand New Client Ltd" },
      });
      expect(customer).not.toBeNull();
      const contact = await owner.contact.findFirstOrThrow({ where: { email: contactEmail } });
      expect(contact.customerId).toBe(customer!.id);
      // The phone the importer cannot carry.
      expect(contact.phone).toBe("+447700900123");
    });

    it("REUSES an existing client rather than making a second one", async () => {
      // Case-insensitive exact name, exactly as `resolveCustomer` does it for
      // an upload — otherwise "alpha trading" typed today becomes a separate
      // client from "Alpha Trading" imported yesterday.
      const before = await owner.customer.count({ where: { organisationId: org.id } });
      const response = await addRow({ clientName: "alpha trading" }).expect(201);
      const after = await owner.customer.count({ where: { organisationId: org.id } });
      expect(after).toBe(before);
      const invoice = await owner.invoice.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(invoice.customerId).toBe(customerA);
    });

    /**
     * ⚠️ THE PROBLEM THIS SOLVES IS A FREELANCER WITH TWO CLIENTS CALLED IMRAN
     * KHALID. A name cannot tell them apart, so the screen sends the id of the
     * one that was picked and the name is not matched at all.
     */
    it("puts the invoice on the PICKED client, ignoring the name entirely", async () => {
      const before = await owner.customer.count({ where: { organisationId: org.id } });
      const response = await addRow({
        customerId: customerB,
        // Deliberately the OTHER client's name. The id must win, and nothing
        // may be created from the name that lost.
        clientName: "Alpha Trading",
      }).expect(201);

      const invoice = await owner.invoice.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(invoice.customerId).toBe(customerB);
      expect(await owner.customer.count({ where: { organisationId: org.id } })).toBe(before);
    });

    it("refuses a picked client that does not exist, rather than inventing one", async () => {
      const before = await owner.customer.count({ where: { organisationId: org.id } });
      await addRow({ customerId: randomUUID(), clientName: "Ghost Ltd" }).expect(404);
      expect(await owner.customer.count({ where: { organisationId: org.id } })).toBe(before);
    });

    it("still refuses a typed name that two clients share, and says to pick instead", async () => {
      const twin = `Imran Khalid ${randomUUID().slice(0, 6)}`;
      for (const suffix of ["one", "two"]) {
        await owner.customer.create({
          data: { organisationId: org.id, name: twin, reference: `IK-${suffix}` },
        });
      }
      const refused = await addRow({ clientName: twin }).expect(409);
      expect(String(refused.body.message)).toContain("Pick the one you mean");

      // ...and picking one of them by id goes through, which is the way out.
      const picked = await owner.customer.findFirstOrThrow({
        where: { organisationId: org.id, name: twin, reference: "IK-two" },
      });
      const response = await addRow({ customerId: picked.id, clientName: twin }).expect(201);
      const invoice = await owner.invoice.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(invoice.customerId).toBe(picked.id);
    });

    it("lands as a draft by default, so nothing is chased by accident", async () => {
      const response = await addRow({}).expect(201);
      expect(response.body.status).toBe("draft");
    });

    /**
     * ⚠️ UNLIKE AN IMPORT. Imported rows are forced to Draft because nobody has
     * read them; a row somebody has just typed has been read by definition.
     */
    it("can start chasing immediately when asked", async () => {
      const response = await addRow({
        status: "active",
        contactName: "Grace Hopper",
        contactEmail: `grace-${randomUUID().slice(0, 8)}@typed.example`,
      }).expect(201);
      expect(response.body.status).toBe("active");
      const scheduled = await owner.scheduledAction.count({
        where: { invoiceId: response.body.id },
      });
      expect(scheduled).toBeGreaterThan(0);
      /**
       * This fixture organisation has no mailbox, and the row says so rather
       * than claiming a chase — the two systems composing correctly. Reminders
       * are still SCHEDULED (that gate is about the contact), which is why both
       * assertions belong together: queued rows and nothing able to send them.
       */
      expect(response.body.chaseBlockedReason).toBe("no_mailbox");
    });

    it("refuses a phone number with no country code", async () => {
      // A dialler cannot ring "07700 900123" without knowing the country, and
      // free text now is a data-cleaning project later.
      const refused = await addRow({ contactPhone: "07700 900123" }).expect(400);
      expect(JSON.stringify(refused.body)).toMatch(/country code/i);
      await addRow({ contactPhone: "+441134960000" }).expect(201);
    });

    it("refuses a duplicate invoice number, like every other create path", async () => {
      const number = `TYPED-DUP-${randomUUID().slice(0, 6)}`;
      await addRow({ invoiceNumber: number }).expect(201);
      await addRow({ invoiceNumber: number }).expect(409);
    });

    it("refuses zero, negative and fractional amounts", async () => {
      await addRow({ amountMinorUnits: 0 }).expect(400);
      await addRow({ amountMinorUnits: -1 }).expect(400);
      await addRow({ amountMinorUnits: 1.5 }).expect(400);
    });

    it("needs invoices:write — read_only is refused", async () => {
      await addRow({}, readOnlyToken).expect(403);
    });

    it("keeps the currency's own decimals", async () => {
      const response = await addRow({ amountMinorUnits: 987_654, currency: "KWD" }).expect(201);
      expect(response.body.amountMinorUnits).toBe(987_654);
      expect(response.body.currency).toBe("KWD");
    });

    it("audits the create like any other invoice", async () => {
      const response = await addRow({}).expect(201);
      const audit = await owner.auditLog.findFirst({
        where: { organisationId: org.id, entityId: response.body.id, action: "invoice.created" },
      });
      expect(audit).not.toBeNull();
    });
  });

  it("is readable by read_only, and scoped to the caller's organisation", async () => {
    await book("?limit=1", readOnlyToken).expect(200);
    const other = await createOrgWithMembers(owner, "book-other", ["owner"]);
    const otherToken = await signToken({
      sub: other.members[0]!.authUserId,
      email: other.members[0]!.email,
    });
    const response = await request(app.getHttpServer())
      .get(`/organisations/${other.id}/invoices`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(200);
    // A different organisation's book is empty, not this one's. Both totals,
    // because the filtered one is hand-written SQL and asserts its own tenant.
    expect(response.body.rows).toHaveLength(0);
    expect(response.body.chasedByCurrency).toHaveLength(0);
    expect(response.body.matchedByCurrency).toHaveLength(0);
  });
});

/**
 * Recording a payment (slice 1.6c, tasks 5-7).
 *
 * ⚠️ WHAT THIS IS FOR. A debtor who owed 10,000 and paid 6,000 used to leave
 * two bad choices: leave the invoice Active and Eva chases the FULL 10,000, or
 * cancel it and Eva stops chasing the 4,000 still owed. Migration 0019 added
 * `amount_paid_minor_units` for exactly this and nothing ever wrote to it.
 */
describe("Invoices: recording a payment", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  let contactId: string;
  const tokens = new Map<string, string>();

  const baseUrl = () => `/organisations/${org.id}/customers/${customerId}/invoices`;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "payments", ["owner", "finance", "read_only"]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
    const ownerId = org.members.find((m) => m.roleKey === "owner")!.id;
    await owner.emailAccount.create({
      data: {
        organisationId: org.id,
        provider: "microsoft",
        emailAddress: `pay-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: true,
      },
    });
    customerId = (
      await owner.customer.create({
        data: { id: randomUUID(), organisationId: org.id, name: "Payer Ltd", createdBy: ownerId },
      })
    ).id;
    contactId = (
      await owner.contact.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          customerId,
          name: "Accounts",
          email: `pay-ap-${randomUUID().slice(0, 8)}@example.com`,
          createdBy: ownerId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /** An issued invoice for 10,000.00, with a recipient, being chased. */
  async function issued(overrides: Record<string, unknown> = {}) {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({
        invoiceNumber: `PAY-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 1_000_000,
        dueDate: orgDate(7),
        contactId,
        status: "active",
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string; status: string };
  }

  function pay(invoiceId: string, body: Record<string, unknown>, role = "finance") {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .send(body);
  }

  it("a part payment leaves partially_paid, with the balance still owed", async () => {
    const invoice = await issued();
    const paid = await pay(invoice.id, { amountMinorUnits: 600_000 }).expect(200);
    expect(paid.body.status).toBe("partially_paid");
    expect(paid.body.amountPaidMinorUnits).toBe(600_000);
    expect(paid.body.outstandingMinorUnits).toBe(400_000);
    expect(paid.body.lastPaymentAt).not.toBeNull();
  });

  /**
   * ⚠️ THE TRAP THIS WHOLE FEATURE NEARLY WALKED INTO, AND THE REASON
   * `CHASED_INVOICE_STATUSES` EXISTS.
   *
   * The scheduler's eligibility gate, both reconcile-sweep queries and the
   * display derivation all asked `status === "active"`. Moving a part-paid
   * invoice to `partially_paid` would therefore have made Eva stop chasing the
   * balance — the precise defect migration 0019 was created to fix, arriving by
   * the back door and looking like a feature.
   */
  it("KEEPS CHASING a part-paid invoice — the reminders are not cancelled", async () => {
    const invoice = await issued();
    const before = await owner.scheduledAction.count({
      where: { invoiceId: invoice.id, status: { in: ["pending", "ready"] } },
    });
    expect(before).toBeGreaterThan(0);

    const paid = await pay(invoice.id, { amountMinorUnits: 1 }).expect(200);
    expect(paid.body.status).toBe("partially_paid");

    const after = await owner.scheduledAction.count({
      where: { invoiceId: invoice.id, status: { in: ["pending", "ready"] } },
    });
    expect(after).toBe(before);
    // And the scheduler must still consider it eligible, or 1.7 would refuse
    // every one of those rows at send time.
    expect(paid.body.chaseBlockedReason).toBeNull();
  });

  it("a part-paid invoice past its due date still reads OVERDUE", async () => {
    // Derivation used to apply to `active` only, so a part-paid invoice forty
    // days late could never show Overdue — dropping it out of every overdue
    // view, which is exactly where a debtor who paid a token amount belongs.
    const invoice = await issued({ dueDate: orgDate(-40) });
    const paid = await pay(invoice.id, { amountMinorUnits: 1000 }).expect(200);
    expect(paid.body.status).toBe("partially_paid");
    expect(paid.body.displayStatus).toBe("overdue");
  });

  it("a part-paid invoice NOT yet due reads as part paid", async () => {
    const invoice = await issued({ dueDate: orgDate(30) });
    const paid = await pay(invoice.id, { amountMinorUnits: 1000 }).expect(200);
    expect(paid.body.displayStatus).toBe("partially_paid");
  });

  it("payment to the exact balance settles it and stops the chase", async () => {
    const invoice = await issued();
    const paid = await pay(invoice.id, { amountMinorUnits: 1_000_000 }).expect(200);
    expect(paid.body.status).toBe("paid");
    expect(paid.body.outstandingMinorUnits).toBe(0);
    const live = await owner.scheduledAction.count({
      where: { invoiceId: invoice.id, status: { in: ["pending", "ready"] } },
    });
    expect(live).toBe(0);
  });

  it("two part payments that together clear it settle it", async () => {
    const invoice = await issued();
    await pay(invoice.id, { amountMinorUnits: 400_000 }).expect(200);
    const second = await pay(invoice.id, { amountMinorUnits: 600_000 }).expect(200);
    expect(second.body.status).toBe("paid");
    expect(second.body.amountPaidMinorUnits).toBe(1_000_000);
    expect(second.body.outstandingMinorUnits).toBe(0);
  });

  it("overpayment is allowed, and the balance clamps at zero rather than going negative", async () => {
    // Founder ruling 2026-08-02. A debtor who rounds up or settles two invoices
    // with one transfer is real, and refusing to record what actually arrived
    // would leave the customer's books disagreeing with their bank.
    const invoice = await issued();
    const paid = await pay(invoice.id, { amountMinorUnits: 1_500_000 }).expect(200);
    expect(paid.body.status).toBe("paid");
    expect(paid.body.amountPaidMinorUnits).toBe(1_500_000);
    expect(paid.body.outstandingMinorUnits).toBe(0);
  });

  it("records the payment DATE, which is what makes days-to-pay computable", async () => {
    const invoice = await issued();
    const paid = await pay(invoice.id, {
      amountMinorUnits: 1_000_000,
      paidAt: "2026-07-15",
    }).expect(200);
    expect(String(paid.body.lastPaymentAt)).toContain("2026-07-15");
    const stored = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stored.lastPaymentAt).not.toBeNull();
  });

  it("a payment on a PAUSED invoice records the money and leaves it paused", async () => {
    /**
     * Somebody paused that chase deliberately — a query, a dispute — and them
     * banking a part payment is not them asking for it to start again. Moving
     * it to `partially_paid` would silently resume chasing, because that IS a
     * chased status.
     */
    const invoice = await issued();
    await request(app.getHttpServer())
      .post(`${baseUrl()}/${invoice.id}/pause`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);

    const paid = await pay(invoice.id, { amountMinorUnits: 100_000 }).expect(200);
    expect(paid.body.status).toBe("paused");
    expect(paid.body.amountPaidMinorUnits).toBe(100_000);
    // Still paused, so still not chased — and the reason says so.
    const live = await owner.scheduledAction.count({
      where: { invoiceId: invoice.id, status: { in: ["pending", "ready"] } },
    });
    expect(live).toBe(0);
  });

  it("settling a PAUSED invoice does mark it paid, because that is what happened", async () => {
    const invoice = await issued();
    await request(app.getHttpServer())
      .post(`${baseUrl()}/${invoice.id}/pause`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
    const paid = await pay(invoice.id, { amountMinorUnits: 1_000_000 }).expect(200);
    expect(paid.body.status).toBe("paid");
  });

  it("refuses a payment on a draft — it was never issued", async () => {
    const invoice = await issued({ status: "draft" });
    const refused = await pay(invoice.id, { amountMinorUnits: 1000 }).expect(409);
    expect(String(refused.body.message)).toMatch(/draft/i);
  });

  /**
   * ⚠️ AND THE MONEY MUST NOT BE WRITTEN EITHER. The status change and the
   * amount move in one transaction on purpose: a recorded payment on an invoice
   * whose status did not follow is the two-numbers-disagree failure this slice
   * exists to remove.
   */
  it("refuses a payment on a cancelled invoice, and writes nothing at all", async () => {
    const invoice = await issued();
    await request(app.getHttpServer())
      .post(`${baseUrl()}/${invoice.id}/cancel`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);

    await pay(invoice.id, { amountMinorUnits: 1000 }).expect(409);

    const stored = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stored.status).toBe("cancelled");
    expect(stored.amountPaidMinorUnits).toBe(0n);
    expect(stored.lastPaymentAt).toBeNull();
  });

  it("refuses a second payment once it is settled", async () => {
    const invoice = await issued();
    await pay(invoice.id, { amountMinorUnits: 1_000_000 }).expect(200);
    await pay(invoice.id, { amountMinorUnits: 500 }).expect(409);
  });

  it("rejects zero, negative and fractional amounts", async () => {
    const invoice = await issued();
    await pay(invoice.id, { amountMinorUnits: 0 }).expect(400);
    await pay(invoice.id, { amountMinorUnits: -500 }).expect(400);
    await pay(invoice.id, { amountMinorUnits: 12.5 }).expect(400);
  });

  it("rejects a status field on the payload — the balance decides, not the caller", async () => {
    // There is no "mark as paid" in this API. The schema is strict so an
    // attempt to assert one is a 400 rather than a silently ignored field.
    const invoice = await issued();
    await pay(invoice.id, { amountMinorUnits: 1000, status: "paid" }).expect(400);
  });

  it("needs invoices:write — read_only is refused and nothing is written", async () => {
    const invoice = await issued();
    await pay(invoice.id, { amountMinorUnits: 1000 }, "read_only").expect(403);
    const stored = await owner.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stored.amountPaidMinorUnits).toBe(0n);
  });

  it("audits the payment with the status it moved between, and no amount", async () => {
    // BRD 14: audit metadata carries counts, ids and outcomes — never money.
    const invoice = await issued();
    await pay(invoice.id, { amountMinorUnits: 600_000 }).expect(200);
    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: invoice.id, action: "invoice.payment_recorded" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({ from: "active", to: "partially_paid", settled: false });
    expect(JSON.stringify(audit!.metadata)).not.toContain("600000");
  });

  it("handles a currency with three decimals without losing the third digit", async () => {
    // 987.654 KWD is 987654 fils. A part payment of 500.000 leaves 487.654.
    const invoice = await issued({ amountMinorUnits: 987_654, currency: "KWD" });
    const paid = await pay(invoice.id, { amountMinorUnits: 500_000 }).expect(200);
    expect(paid.body.outstandingMinorUnits).toBe(487_654);
    expect(paid.body.currency).toBe("KWD");
  });
});

/**
 * `chaseBlockedReason` — why Eva would not email a reminder (slice 1.6c).
 *
 * ⚠️ WHAT THIS IS DEFENDING. Before it, the screens could see exactly ONE of
 * the ways a chase silently does not happen — a missing recipient — and said
 * "Eva will chase it" in every other case. An invoice whose contact has no
 * email address, or who asked not to be emailed, or whose organisation has no
 * working mailbox, gets zero scheduled rows and reports success.
 *
 * Each case below therefore asserts the reason AND that nothing was scheduled,
 * because a reason that disagrees with the scheduler is the same defect wearing
 * a label.
 */
describe("Invoices: chaseBlockedReason (does Eva actually chase this?)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  /** Has a live, healthy mailbox — so only per-invoice reasons can fire. */
  let org: FixtureOrg;
  /** No mailbox at all, so nothing in it can ever be sent. */
  let mailboxless: FixtureOrg;
  let customerId: string;
  let mailboxlessCustomerId: string;
  let token: string;
  let mailboxlessToken: string;
  let ownerUserId: string;

  const url = (orgId: string, custId: string) =>
    `/organisations/${orgId}/customers/${custId}/invoices`;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();

    org = await createOrgWithMembers(owner, "chase-blockers", ["owner"]);
    mailboxless = await createOrgWithMembers(owner, "chase-nomailbox", ["owner"]);
    const member = org.members[0]!;
    ownerUserId = member.id;
    token = await signToken({ sub: member.authUserId, email: member.email });
    const other = mailboxless.members[0]!;
    mailboxlessToken = await signToken({ sub: other.authUserId, email: other.email });

    await owner.emailAccount.create({
      data: {
        organisationId: org.id,
        provider: "microsoft",
        emailAddress: `chase-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: true,
      },
    });

    customerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Chased Ltd",
          createdBy: member.id,
        },
      })
    ).id;
    mailboxlessCustomerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: mailboxless.id,
          name: "Unchased Ltd",
          createdBy: other.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  async function makeContact(overrides: { email?: string | null } = {}) {
    return owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId,
        name: "Accounts",
        email:
          overrides.email === undefined
            ? `ap-${randomUUID().slice(0, 8)}@example.com`
            : overrides.email,
        createdBy: ownerUserId,
      },
    });
  }

  async function raise(
    body: Record<string, unknown>,
    target = { orgId: org.id, custId: customerId, auth: token },
  ) {
    return request(app.getHttpServer())
      .post(url(target.orgId, target.custId))
      .set("Authorization", `Bearer ${target.auth}`)
      .send({
        invoiceNumber: `CB-${randomUUID().slice(0, 8)}`,
        amountMinorUnits: 5000,
        dueDate: orgDate(10),
        status: "active",
        ...body,
      })
      .expect(201);
  }

  /** How many reminder rows the invoice actually got. */
  async function scheduledCount(invoiceId: string): Promise<number> {
    return owner.scheduledAction.count({ where: { invoiceId } });
  }

  it("is null when Eva really will chase it, and rows are actually scheduled", async () => {
    const contact = await makeContact();
    const invoice = await raise({ contactId: contact.id });
    expect(invoice.body.chaseBlockedReason).toBeNull();
    expect(await scheduledCount(invoice.body.id)).toBeGreaterThan(0);
  });

  it("says no_contact, and schedules nothing", async () => {
    const invoice = await raise({});
    expect(invoice.body.chaseBlockedReason).toBe("no_contact");
    expect(await scheduledCount(invoice.body.id)).toBe(0);
  });

  it("says no_email, and schedules nothing", async () => {
    const contact = await makeContact({ email: null });
    const invoice = await raise({ contactId: contact.id });
    expect(invoice.body.chaseBlockedReason).toBe("no_email");
    expect(await scheduledCount(invoice.body.id)).toBe(0);
  });

  it("says suppressed when the contact asked not to be emailed", async () => {
    const contact = await makeContact();
    await owner.suppressionEvent.create({
      data: {
        organisationId: org.id,
        channel: "email",
        value: contact.email!.toLowerCase(),
        reason: "unsubscribed",
      },
    });
    const invoice = await raise({ contactId: contact.id });
    expect(invoice.body.chaseBlockedReason).toBe("suppressed");
    expect(await scheduledCount(invoice.body.id)).toBe(0);
  });

  it("says contact_deleted when the recipient is removed AFTER the invoice", async () => {
    /**
     * ⚠️ THE ORDER HERE IS THE POINT, and the first version of this test got it
     * wrong. Attaching an already-deleted contact is refused 400 — correctly.
     * The reachable case is the real-world one: a live contact is chosen, the
     * invoice starts being chased, and somebody removes the person months
     * later. Soft-deleted contacts stay linked on `invoices.contact_id` (the
     * 1.4 observation), so the invoice keeps pointing at a recipient who can no
     * longer be emailed, and the chase goes quiet with nothing on screen to say
     * so. That is exactly what this field is for.
     */
    const contact = await makeContact();
    const invoice = await raise({ contactId: contact.id });
    expect(invoice.body.chaseBlockedReason).toBeNull();

    await owner.contact.update({ where: { id: contact.id }, data: { deletedAt: new Date() } });

    const after = await request(app.getHttpServer())
      .get(`${url(org.id, customerId)}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(after.body.chaseBlockedReason).toBe("contact_deleted");
  });

  it("says no_mailbox when the organisation has nowhere to send from", async () => {
    const contact = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: mailboxless.id,
        customerId: mailboxlessCustomerId,
        name: "Accounts",
        email: `ap-${randomUUID().slice(0, 8)}@example.com`,
        createdBy: mailboxless.members[0]!.id,
      },
    });
    const invoice = await raise(
      { contactId: contact.id },
      { orgId: mailboxless.id, custId: mailboxlessCustomerId, auth: mailboxlessToken },
    );
    expect(invoice.body.chaseBlockedReason).toBe("no_mailbox");
  });

  it("stops reporting no_mailbox once a mailbox is connected", async () => {
    // Proves the reason is READ from the data rather than stamped once: the
    // same invoice must change its answer when the organisation does.
    const contact = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: mailboxless.id,
        customerId: mailboxlessCustomerId,
        name: "Accounts Two",
        email: `ap2-${randomUUID().slice(0, 8)}@example.com`,
        createdBy: mailboxless.members[0]!.id,
      },
    });
    const invoice = await raise(
      { contactId: contact.id },
      { orgId: mailboxless.id, custId: mailboxlessCustomerId, auth: mailboxlessToken },
    );
    expect(invoice.body.chaseBlockedReason).toBe("no_mailbox");

    const account = await owner.emailAccount.create({
      data: {
        organisationId: mailboxless.id,
        provider: "microsoft",
        emailAddress: `late-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: true,
      },
    });
    const after = await request(app.getHttpServer())
      .get(`${url(mailboxless.id, mailboxlessCustomerId)}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${mailboxlessToken}`)
      .expect(200);
    expect(after.body.chaseBlockedReason).toBeNull();

    // An UNHEALTHY mailbox is not a mailbox: expiry must bring the block back,
    // because `resolveSendingMailbox` would return null for it too.
    await owner.emailAccount.update({
      where: { id: account.id },
      data: { healthStatus: "auth_expired" },
    });
    const expired = await request(app.getHttpServer())
      .get(`${url(mailboxless.id, mailboxlessCustomerId)}/${invoice.body.id}`)
      .set("Authorization", `Bearer ${mailboxlessToken}`)
      .expect(200);
    expect(expired.body.chaseBlockedReason).toBe("no_mailbox");

    await owner.emailAccount.update({
      where: { id: account.id },
      data: { healthStatus: "active" },
    });
  });

  /**
   * ⚠️ THE STATUS IS SET ASIDE ON PURPOSE, and this is the test that pins it.
   *
   * A DRAFT with no recipient must report `no_contact`, not "it's a draft" —
   * because the Start chasing button asks what will happen AFTER the status
   * changes, and "it's a draft" is useless for predicting that. It is also what
   * lets a cancelled invoice's row stay quiet: the badge already says
   * Cancelled, so the reason field has nothing to add.
   */
  it("answers about the CONTACT even for a draft, so the button can predict", async () => {
    const draft = await raise({ status: "draft" });
    expect(draft.body.status).toBe("draft");
    expect(draft.body.chaseBlockedReason).toBe("no_contact");

    const good = await makeContact();
    const ready = await raise({ status: "draft", contactId: good.id });
    expect(ready.body.chaseBlockedReason).toBeNull();
    // Still a draft, so nothing is scheduled yet — the reason is a forecast,
    // not a claim that Eva is chasing it today.
    expect(await scheduledCount(ready.body.id)).toBe(0);
  });

  it("reports the same reasons through the list as through a single read", async () => {
    // The list computes them in a batch (two queries for any number of rows);
    // a single read takes the same path with one invoice. They must not drift.
    const list = await request(app.getHttpServer())
      .get(url(org.id, customerId))
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.length).toBeGreaterThan(3);
    for (const row of list.body) {
      const one = await request(app.getHttpServer())
        .get(`${url(org.id, customerId)}/${row.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(one.body.chaseBlockedReason).toBe(row.chaseBlockedReason);
    }
    // And the batch must have produced more than one distinct answer, or this
    // proves nothing about the batching.
    expect(
      new Set(list.body.map((row: { chaseBlockedReason: string | null }) => row.chaseBlockedReason))
        .size,
    ).toBeGreaterThan(1);
  });
});
