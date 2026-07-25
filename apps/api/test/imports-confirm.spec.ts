import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";
import { ImportsService } from "../src/modules/imports/imports.service.js";

/**
 * Import confirm + cancel (Slice 1.3 plan §3/§7): synchronous confirm in one
 * transaction, Draft-only output (§7.7), duplicates skipped never upserted
 * (§7.3), auto-created customers/contacts (§7.2), suppression flags (§7.4),
 * the status machine, and failure rollback (§8 risk 3).
 */

const HEADERS =
  "Invoice Number,Amount,Due Date,Customer Name,Customer Email,Contact Name,Contact Email";

function csvRows(...rows: string[]): Buffer {
  return Buffer.from([HEADERS, ...rows].join("\r\n"), "utf8");
}

/** YYYY-MM-DD for today in the given timezone (mirrors invoices.spec). */
function orgToday(timezone = "Europe/London"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

describe("Imports: confirm and cancel", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();
  const memberByRole = new Map<string, { id: string }>();

  const baseUrl = () => `/organisations/${org.id}/imports`;

  async function upload(file: Buffer, role = "finance") {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .attach("file", file, "ledger.csv")
      .expect(201);
    return response.body as { id: string; rows: { id: string; status: string }[] };
  }

  function confirm(importId: string, role = "finance"): request.Test {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${importId}/confirm`)
      .set("Authorization", `Bearer ${tokens.get(role)}`);
  }

  function cancel(importId: string, role = "finance"): request.Test {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${importId}/cancel`)
      .set("Authorization", `Bearer ${tokens.get(role)}`);
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "imports-confirm", [
      "owner",
      "finance",
      "sales",
      "read_only",
    ]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      memberByRole.set(member.roleKey, member);
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("confirms: creates DRAFT invoices, customers and contacts; counts + audit (§7.2/§7.7)", async () => {
    const staged = await upload(
      csvRows(
        "CF-1,123.45,01/09/2026,Confirm Co,ap@confirm.test,Accounts,billing@confirm.test",
        "CF-2,10.00,2026-09-15,Confirm Co,ap@confirm.test,Accounts,billing@confirm.test",
        "CF-3,not-a-number,01/09/2026,Confirm Co,,,",
      ),
    );
    const response = await confirm(staged.id).expect(200);
    expect(response.body.status).toBe("completed");
    expect(response.body).toMatchObject({
      totalRows: 3,
      validRows: 2,
      invalidRows: 1,
      createdRows: 2,
    });
    const rows = response.body.rows as {
      status: string;
      errors: string[];
      createdInvoiceId: string | null;
    }[];
    expect(rows[0]!.status).toBe("imported");
    expect(rows[0]!.createdInvoiceId).not.toBeNull();
    expect(rows[0]!.errors.join(" ")).toMatch(/was created by this import/);
    expect(rows[2]!.status).toBe("invalid");
    expect(rows[2]!.createdInvoiceId).toBeNull();

    // Invoices landed as Draft with parsed values (BRD 10 minor units).
    const invoices = await owner.invoice.findMany({
      where: { organisationId: org.id, invoiceNumber: { in: ["CF-1", "CF-2"] } },
    });
    expect(invoices).toHaveLength(2);
    expect(invoices.every((invoice) => invoice.status === "draft")).toBe(true);
    const cf1 = invoices.find((invoice) => invoice.invoiceNumber === "CF-1")!;
    expect(cf1.amountMinorUnits).toBe(12345);
    expect(cf1.currency).toBe("GBP");
    expect(cf1.dueDate.toISOString().slice(0, 10)).toBe("2026-09-01");
    // No issue date in the file → creation day in the org timezone (BRD 18.1).
    expect(cf1.issueDate.toISOString().slice(0, 10)).toBe(orgToday());
    expect(cf1.contactId).not.toBeNull();

    // Exactly ONE customer and ONE contact created (deduped across rows).
    const customers = await owner.customer.findMany({
      where: { organisationId: org.id, name: "Confirm Co" },
    });
    expect(customers).toHaveLength(1);
    expect(customers[0]!.email).toBe("ap@confirm.test");
    const contacts = await owner.contact.findMany({
      where: { organisationId: org.id, customerId: customers[0]!.id },
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.email).toBe("billing@confirm.test");

    // Audit: counts only, never amounts or customer detail (BRD 14).
    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: staged.id, action: "import.completed" },
    });
    expect(audit).toBeDefined();
    expect(audit?.metadata).toMatchObject({ totalRows: 3, createdRows: 2, customersCreated: 1 });
    expect(JSON.stringify(audit?.metadata)).not.toContain("123.45");
    expect(JSON.stringify(audit?.metadata)).not.toContain("CF-1");
  });

  it("matches an existing customer by reference — nothing is created", async () => {
    await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Existing Ref Co",
        reference: "REF-7001",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const staged = await upload(
      Buffer.from(
        "Invoice Number,Amount,Due Date,Customer Reference\r\nCFR-1,7.50,01/09/2026,REF-7001\r\n",
        "utf8",
      ),
    );
    const response = await confirm(staged.id).expect(200);
    expect(response.body.createdRows).toBe(1);
    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "CFR-1" },
    });
    const customer = await owner.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
    expect(customer.name).toBe("Existing Ref Co");
    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: staged.id, action: "import.completed" },
    });
    expect(audit?.metadata).toMatchObject({ customersCreated: 0 });
  });

  it("reuses an existing contact with the same normalised email on that customer", async () => {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Contact Dedup Co",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const existing = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        name: "Original Name",
        email: "dedup@contact.test",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const staged = await upload(
      csvRows("CDC-1,5.00,01/09/2026,Contact Dedup Co,,New Name,dedup@contact.test"),
    );
    await confirm(staged.id).expect(200);
    const contacts = await owner.contact.findMany({
      where: { organisationId: org.id, customerId: customer.id },
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.id).toBe(existing.id);
    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "CDC-1" },
    });
    expect(invoice.contactId).toBe(existing.id);
  });

  it("skips duplicates and within-file duplicates at confirm — never upserts (§7.3)", async () => {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Skip Dup Co",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        invoiceNumber: "SKIP-1",
        amountMinorUnits: 111,
        issueDate: new Date(),
        dueDate: new Date(),
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const staged = await upload(
      csvRows(
        "SKIP-1,9.99,01/09/2026,Skip Dup Co,,,",
        "SKIP-2,1.00,01/09/2026,Skip Dup Co,,,",
        "SKIP-2,2.00,01/09/2026,Skip Dup Co,,,",
      ),
    );
    const response = await confirm(staged.id).expect(200);
    expect(response.body.createdRows).toBe(1);
    // The pre-existing invoice is untouched (never upserted).
    const existing = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "SKIP-1" },
    });
    expect(existing.amountMinorUnits).toBe(111);
    const skip2s = await owner.invoice.findMany({
      where: { organisationId: org.id, invoiceNumber: "SKIP-2" },
    });
    expect(skip2s).toHaveLength(1);
    expect(skip2s[0]!.amountMinorUnits).toBe(100);
  });

  it("flags a number that becomes live between staging and confirm as duplicate", async () => {
    const staged = await upload(csvRows("RACE-1,1.00,01/09/2026,Race Co,,,"));
    expect(staged.rows[0]!.status).toBe("valid");
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Race Co",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        invoiceNumber: "RACE-1",
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const response = await confirm(staged.id).expect(200);
    expect(response.body.createdRows).toBe(0);
    expect(response.body.rows[0].status).toBe("duplicate");
    expect(response.body.status).toBe("completed");
  });

  it("imports suppressed rows as Draft and keeps the suppressed flag (§7.4)", async () => {
    await owner.suppressionEntry.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        channel: "email",
        value: "sup-confirm@test.eva.local",
      },
    });
    const staged = await upload(
      csvRows("SUPC-1,3.00,01/09/2026,Sup Confirm Co,,,sup-confirm@test.eva.local"),
    );
    expect(staged.rows[0]!.status).toBe("suppressed");
    const response = await confirm(staged.id).expect(200);
    expect(response.body.createdRows).toBe(1);
    expect(response.body.rows[0].status).toBe("suppressed");
    expect(response.body.rows[0].createdInvoiceId).not.toBeNull();
    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "SUPC-1" },
    });
    expect(invoice.status).toBe("draft");
  });

  it("rolls the whole transaction back on unexpected failure → failed, zero rows land (§8 risk 3)", async () => {
    const staged = await upload(
      csvRows("FAIL-1,1.00,01/09/2026,Rollback Co,,,", "FAIL-2,2.00,01/09/2026,Rollback Co,,,"),
    );
    const service = app.get(ImportsService);
    const spy = vi
      .spyOn(
        service as unknown as {
          createImportedInvoice: (...args: unknown[]) => Promise<unknown>;
        },
        "createImportedInvoice",
      )
      .mockRejectedValueOnce(new Error("boom"));
    try {
      const response = await confirm(staged.id).expect(500);
      // 5xx messages are sanitised by the global filter (BRD 14) — the client
      // sees the generic message; the import record carries the outcome.
      expect(response.body.message).toBe("Internal server error");
    } finally {
      spy.mockRestore();
    }

    const importRecord = await owner.import.findUniqueOrThrow({ where: { id: staged.id } });
    expect(importRecord.status).toBe("failed");
    // Nothing landed: no invoices, no customer, no contact.
    expect(
      await owner.invoice.count({
        where: { organisationId: org.id, invoiceNumber: { in: ["FAIL-1", "FAIL-2"] } },
      }),
    ).toBe(0);
    expect(
      await owner.customer.count({ where: { organisationId: org.id, name: "Rollback Co" } }),
    ).toBe(0);
    // Staged rows are untouched (the row updates rolled back too).
    const rows = await owner.importRow.findMany({ where: { importId: staged.id } });
    expect(rows.every((row) => row.status === "valid")).toBe(true);
    expect(rows.every((row) => row.createdInvoiceId === null)).toBe(true);

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: staged.id, action: "import.failed" },
    });
    expect(audit).toBeDefined();
    // And import.completed was never written.
    expect(
      await owner.auditLog.count({
        where: { organisationId: org.id, entityId: staged.id, action: "import.completed" },
      }),
    ).toBe(0);
  });

  it("confirm-twice → 409", async () => {
    const staged = await upload(csvRows("TW-1,1.00,01/09/2026,Twice Co,,,"));
    await confirm(staged.id).expect(200);
    const response = await confirm(staged.id).expect(409);
    expect(response.body.message).toMatch(/completed/);
  });

  it("confirm-after-cancel → 409; cancel-after-confirm → 409", async () => {
    const cancelled = await upload(csvRows("CX-1,1.00,01/09/2026,Cancel Co,,,"));
    await cancel(cancelled.id).expect(200);
    await confirm(cancelled.id).expect(409);

    const completed = await upload(csvRows("CX-2,1.00,01/09/2026,Cancel Co,,,"));
    await confirm(completed.id).expect(200);
    await cancel(completed.id).expect(409);
  });

  it("cancels a staged import → cancelled, audit-logged; no invoices created", async () => {
    const staged = await upload(csvRows("CAN-1,1.00,01/09/2026,Can Co,,,"));
    const response = await cancel(staged.id).expect(200);
    expect(response.body.status).toBe("cancelled");
    expect(response.body.createdRows).toBe(0);
    expect(
      await owner.invoice.count({ where: { organisationId: org.id, invoiceNumber: "CAN-1" } }),
    ).toBe(0);
    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: staged.id, action: "import.cancelled" },
    });
    expect(audit).toBeDefined();
  });

  it("rejects confirm and cancel for read_only / sales (default matrix) → 403", async () => {
    const staged = await upload(csvRows("PRM-1,1.00,01/09/2026,Perm Co,,,"));
    await confirm(staged.id, "read_only").expect(403);
    await cancel(staged.id, "sales").expect(403);
    // Still uploaded — the 403s changed nothing.
    const detail = await request(app.getHttpServer())
      .get(`${baseUrl()}/${staged.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(detail.body.status).toBe("uploaded");
  });

  it("returns 404 for a nonexistent import id", async () => {
    await confirm(randomUUID()).expect(404);
    await cancel(randomUUID()).expect(404);
    await request(app.getHttpServer())
      .get(`${baseUrl()}/${randomUUID()}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(404);
  });

  it("imported invoices activate only via the 1.2 endpoint (BRD 4.1)", async () => {
    const staged = await upload(csvRows("ACT-1,1.00,01/09/2026,Activate Co,,,"));
    const response = await confirm(staged.id).expect(200);
    const invoiceId = response.body.rows[0].createdInvoiceId as string;
    const customer = await owner.customer.findFirstOrThrow({
      where: { organisationId: org.id, name: "Activate Co" },
    });
    const invoice = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${customer.id}/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(invoice.body.status).toBe("draft");
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customer.id}/invoices/${invoiceId}/activate`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
  });
});
