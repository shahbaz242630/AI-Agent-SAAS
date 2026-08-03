import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import type { scheduleInvoiceReminders } from "../src/modules/reminders/reminder-actions.js";
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
      if (reminderActionsMock.failScheduling) {
        return Promise.reject(new Error("forced scheduling failure (test double)"));
      }
      return actual.scheduleInvoiceReminders(tx, input);
    },
  };
});

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

  it("outcome statuses have no API path (plan §7.3): seeded rows reject every action", async () => {
    for (const status of ["paid", "partially_paid", "promise_to_pay", "disputed", "written_off"]) {
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

  it("update schema is structurally status-free: no module file changes status outside the state machine", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const moduleDir = path.resolve(__dirname, "../src/modules/invoices");
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
    const { deriveDisplayStatus } = await import("../src/modules/invoices/invoice-status.js");
    // 2026-03-29 00:30 UTC = 00:30 Europe/London (still GMT) — today is the 29th.
    const now = new Date("2026-03-29T00:30:00Z");
    const due = (day: string) => ({ status: "active", dueDate: new Date(`${day}T00:00:00Z`) });
    expect(deriveDisplayStatus(due("2026-03-29"), "Europe/London", now)).toBe("due_today");
    expect(deriveDisplayStatus(due("2026-03-28"), "Europe/London", now)).toBe("overdue");
    expect(deriveDisplayStatus(due("2026-04-01"), "Europe/London", now)).toBe("due_soon");
    expect(deriveDisplayStatus(due("2026-04-02"), "Europe/London", now)).toBe("active");
  });

  it("derives against the org calendar day at the GMT return (2026-10-25)", async () => {
    const { deriveDisplayStatus } = await import("../src/modules/invoices/invoice-status.js");
    // 2026-10-25 00:30 UTC = 01:30 Europe/London (still BST) — today is the 25th.
    const now = new Date("2026-10-25T00:30:00Z");
    const due = (day: string) => ({ status: "active", dueDate: new Date(`${day}T00:00:00Z`) });
    expect(deriveDisplayStatus(due("2026-10-25"), "Europe/London", now)).toBe("due_today");
    expect(deriveDisplayStatus(due("2026-10-24"), "Europe/London", now)).toBe("overdue");
    expect(deriveDisplayStatus(due("2026-10-28"), "Europe/London", now)).toBe("due_soon");
    expect(deriveDisplayStatus(due("2026-10-29"), "Europe/London", now)).toBe("active");
  });

  it("a UTC instant can be different calendar days in different org timezones", async () => {
    const { deriveDisplayStatus } = await import("../src/modules/invoices/invoice-status.js");
    // 2026-07-01 05:00 UTC: still 2026-07-01 in London, already 2026-07-01 15:00
    // in Sydney (same day), but 2026-06-30 22:00 in Los Angeles (previous day).
    const now = new Date("2026-07-01T05:00:00Z");
    const invoice = { status: "active", dueDate: new Date("2026-07-01T00:00:00Z") };
    expect(deriveDisplayStatus(invoice, "Europe/London", now)).toBe("due_today");
    expect(deriveDisplayStatus(invoice, "America/Los_Angeles", now)).toBe("due_soon");
    expect(deriveDisplayStatus(invoice, "Australia/Sydney", now)).toBe("due_today");
  });

  it("never derives for non-Active statuses", async () => {
    const { deriveDisplayStatus } = await import("../src/modules/invoices/invoice-status.js");
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
    await owner.suppressionEntry.create({
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
