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
import { ImportsService } from "../src/products/invoice-follow-up/imports/imports.service.js";

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
    // bigint, not number: the column is BIGINT since migration 0021. Read
    // straight from Prisma here rather than through the API, which converts.
    expect(cf1.amountMinorUnits).toBe(12345n);
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

  /**
   * 🚨 THE FIVE FACTS EVA NEEDS ABOUT A DEBT, PROVEN AT THE DATABASE.
   *
   * Founder, 2026-08-27: *"how much is outstanding (amount), name of the
   * person, email of the person, phone number of the person… and the date of
   * outstanding. As long as our system gets this information we are good."*
   *
   * ⚠️ IT UPLOADS A FILE SHAPED LIKE A REAL EXPORT, NOT LIKE OUR OWN ADVICE.
   * The headings here are Xero's and Sage's, the total sits to the LEFT of the
   * balance the way an accounting package writes it, and the phone column is
   * headed the way a person heads it. A fixture using the wordings on our
   * upload screen would prove only that we can read our own recommendations —
   * which is the test that existed while three of five real exports failed.
   *
   * ⚠️ AND IT ASSERTS THE AMOUNT IS THE SMALLER FIGURE. That single line is
   * the money bug: `Total` is 1000.00 and `Outstanding` is 400.00 on the same
   * row, so reading the wrong column chases £600 that has already been paid.
   */
  it("takes the outstanding amount and the phone number from a real export (founder, 2026-08-27)", async () => {
    const file = Buffer.from(
      [
        "Invoice Number,Total,Outstanding,Due Date,Customer Name,Customer Email,Phone,Contact Name,Contact Email,Contact Phone",
        "FIVE-1,1000.00,400.00,01/10/2026,Kerrison Joinery,ap@kerrison.test,01632 960111,Dan Kerrison,dan@kerrison.test,07700 900123",
      ].join("\r\n"),
      "utf8",
    );
    const staged = await upload(file);
    await confirm(staged.id).expect(200);

    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "FIVE-1" },
    });
    // 1. how much is outstanding — the balance, NOT the £1,000 invoice total.
    expect(invoice.amountMinorUnits, "Eva took the invoice total, not the debt").toBe(40000n);
    // 5. the date of outstanding.
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe("2026-10-01");

    const customer = await owner.customer.findFirstOrThrow({
      where: { organisationId: org.id, name: "Kerrison Joinery" },
    });
    // 2, 3 and 4 on the client.
    expect(customer.email).toBe("ap@kerrison.test");
    expect(customer.phone, "the client's phone was dropped").toBe("01632 960111");

    const contact = await owner.contact.findFirstOrThrow({
      where: { organisationId: org.id, customerId: customer.id },
    });
    expect(contact.name).toBe("Dan Kerrison");
    expect(contact.email).toBe("dan@kerrison.test");
    expect(contact.phone, "the contact's phone was dropped").toBe("07700 900123");
  });

  /**
   * ⚠️ THE CASE THAT MUST NOT CREATE ANYTHING. A phone number with no name and
   * no email behind it is not a person — and `reminder-message.ts` puts a
   * contact's name straight into "Hi Sarah,". Were a bare number allowed to
   * make a contact, Eva would open a letter chasing a debt with *"Hi 07700
   * 900123,"*, sent from our customer's own mailbox over their name.
   */
  it("will not invent a contact out of a phone number alone", async () => {
    const file = Buffer.from(
      [
        "Invoice Number,Amount,Due Date,Customer Name,Contact Phone",
        "FIVE-2,50.00,01/10/2026,Nameless Contact Co,07700 900999",
      ].join("\r\n"),
      "utf8",
    );
    const staged = await upload(file);
    await confirm(staged.id).expect(200);

    const customer = await owner.customer.findFirstOrThrow({
      where: { organisationId: org.id, name: "Nameless Contact Co" },
    });
    const contacts = await owner.contact.findMany({
      where: { organisationId: org.id, customerId: customer.id },
    });
    expect(contacts, "a contact was invented from a bare phone number").toHaveLength(0);
    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "FIVE-2" },
    });
    expect(invoice.contactId).toBeNull();
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
    expect(existing.amountMinorUnits).toBe(111n);
    const skip2s = await owner.invoice.findMany({
      where: { organisationId: org.id, invoiceNumber: "SKIP-2" },
    });
    expect(skip2s).toHaveLength(1);
    expect(skip2s[0]!.amountMinorUnits).toBe(100n);
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
    await owner.suppressionEvent.create({
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
      // The service catches the raw failure and rethrows a deliberate
      // InternalServerErrorException, so the client reads the message WE wrote.
      // The global filter passes HttpException messages through precisely
      // because they are written for a person; what it still blanks is
      // everything that is not an HttpException, which is where stack text and
      // connection strings live. So "boom" must not appear here.
      expect(response.body.message).toBe("Import failed — no rows were applied");
      expect(JSON.stringify(response.body)).not.toContain("boom");
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
