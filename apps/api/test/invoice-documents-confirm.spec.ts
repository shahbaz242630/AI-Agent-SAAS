import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import PDFDocument from "pdfkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * Invoice-document confirm + cancel (Slice 1.4 plan §7.7 — the hybrid
 * ruling): the confirm body is ALWAYS the complete, final, human-reviewed
 * field set; confirm is allowed from `extracted` AND `failed`; output is a
 * DRAFT invoice (never Active — BRD 4.1); cancel is a soft delete.
 */

function pdfWithLines(lines: string[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 50 });
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.fontSize(12);
    for (const line of lines) {
      doc.text(line);
      doc.moveDown(0.5);
    }
    doc.end();
  });
}

function pdfWithoutText(): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument();
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.rect(10, 10, 100, 100).fill("#cccccc");
    doc.end();
  });
}

/** YYYY-MM-DD for today in the given timezone (mirrors imports-confirm.spec). */
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

describe("Invoice documents: confirm and cancel (the §7.7 hybrid)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();
  const memberByRole = new Map<string, { id: string }>();

  const baseUrl = () => `/organisations/${org.id}/invoice-documents`;

  async function upload(file: Buffer, role = "finance") {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .attach("file", file, "invoice.pdf")
      .expect(201);
    return response.body as { id: string; status: string };
  }

  function confirm(documentId: string, body: object, role = "finance"): request.Test {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${documentId}/confirm`)
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .send(body);
  }

  function cancel(documentId: string, role = "finance"): request.Test {
    return request(app.getHttpServer())
      .post(`${baseUrl()}/${documentId}/cancel`)
      .set("Authorization", `Bearer ${tokens.get(role)}`);
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "invdocs-confirm", [
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

  it("confirm from extracted: human corrections win over the extraction (§7.7)", async () => {
    const staged = await upload(
      await pdfWithLines([
        "Invoice Number: INV-5001",
        "Due Date: 31/08/2026",
        "Bill To: Extracted Co",
        "Total Due: £100.00",
      ]),
    );
    expect(staged.status).toBe("extracted");
    // Extraction said INV-5001 / £100.00 — the human corrected both.
    const response = await confirm(staged.id, {
      invoiceNumber: "INV-5001-CORRECTED",
      amountMinorUnits: 22200,
      currency: "GBP",
      issueDate: "2026-08-01",
      dueDate: "2026-09-30",
      customerName: "Corrected Co",
      customerEmail: "ap@corrected.test",
      contactName: "Human Reviewer",
      contactEmail: "reviewer@corrected.test",
    }).expect(200);
    expect(response.body.suppressed).toBe(false);
    expect(response.body.documentId).toBe(staged.id);
    expect(response.body.invoice).toMatchObject({
      invoiceNumber: "INV-5001-CORRECTED",
      amountMinorUnits: 22200,
      currency: "GBP",
      status: "draft",
    });

    const invoice = await owner.invoice.findUniqueOrThrow({
      where: { id: response.body.invoice.id },
    });
    expect(invoice.status).toBe("draft");
    expect(invoice.issueDate.toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(invoice.contactId).not.toBeNull();

    // The document is confirmed and linked; the original extraction is kept.
    const document = await owner.invoiceDocument.findUniqueOrThrow({ where: { id: staged.id } });
    expect(document.status).toBe("confirmed");
    expect(document.invoiceId).toBe(invoice.id);
    expect(JSON.stringify(document.extractedFields)).toContain("INV-5001");

    const audit = await owner.auditLog.findFirst({
      where: {
        organisationId: org.id,
        entityType: "invoice_document",
        entityId: staged.id,
        action: "invoice_document.confirmed",
      },
    });
    expect(audit?.metadata).toMatchObject({ suppressed: false, customerCreated: true });
    expect(JSON.stringify(audit?.metadata)).not.toContain("22200");
  });

  it("confirm from failed: fully manual values create the Draft invoice (the fallback)", async () => {
    const staged = await upload(await pdfWithoutText());
    expect(staged.status).toBe("failed");
    const response = await confirm(staged.id, {
      invoiceNumber: "MANUAL-1",
      amountMinorUnits: 5000,
      dueDate: "2026-10-01",
      customerName: "Manual Entry Co",
    }).expect(200);
    expect(response.body.invoice.status).toBe("draft");
    const invoice = await owner.invoice.findUniqueOrThrow({
      where: { id: response.body.invoice.id },
    });
    // No issueDate → the confirmation day in the org timezone (BRD 18.1).
    expect(invoice.issueDate.toISOString().slice(0, 10)).toBe(orgToday());
    expect(invoice.currency).toBe("GBP");
    const document = await owner.invoiceDocument.findUniqueOrThrow({ where: { id: staged.id } });
    expect(document.status).toBe("confirmed");
  });

  it("matches an existing customer by case-insensitive name — nothing is created", async () => {
    await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Existing Match Co",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6001", "Total: 10.00"]));
    const response = await confirm(staged.id, {
      invoiceNumber: "INV-6001",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "existing match co",
    }).expect(200);
    const audit = await owner.auditLog.findFirst({
      where: {
        organisationId: org.id,
        entityId: staged.id,
        action: "invoice_document.confirmed",
      },
    });
    expect(audit?.metadata).toMatchObject({ customerCreated: false });
    expect(
      await owner.customer.count({ where: { organisationId: org.id, name: "Existing Match Co" } }),
    ).toBe(1);
    const invoice = await owner.invoice.findUniqueOrThrow({
      where: { id: response.body.invoice.id },
    });
    const customer = await owner.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
    expect(customer.name).toBe("Existing Match Co");
  });

  it("ambiguous customer match → 400, never a guess (the 1.3 rule)", async () => {
    for (let i = 0; i < 2; i++) {
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Doc Ambiguous Ltd",
          createdBy: memberByRole.get("owner")!.id,
        },
      });
    }
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6002", "Total: 10.00"]));
    await confirm(staged.id, {
      invoiceNumber: "INV-6002",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "Doc Ambiguous Ltd",
    }).expect(400);
    // Still extracted — the 400 changed nothing.
    const document = await owner.invoiceDocument.findUniqueOrThrow({ where: { id: staged.id } });
    expect(document.status).toBe("extracted");
    // A unique reference disambiguates.
    await confirm(staged.id, {
      invoiceNumber: "INV-6002",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerReference: "UNIQUE-REF-1",
    }).expect(200);
  });

  it("duplicate invoice number → 409 (pre-check; the 0006 index is the backstop)", async () => {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Doc Dup Co",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        invoiceNumber: "DUP-DOC-1",
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const staged = await upload(await pdfWithLines(["Invoice Number: DUP-DOC-1", "Total: 10.00"]));
    await confirm(staged.id, {
      invoiceNumber: "DUP-DOC-1",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "Doc Dup Co",
    }).expect(409);
    const document = await owner.invoiceDocument.findUniqueOrThrow({ where: { id: staged.id } });
    expect(document.status).toBe("extracted");
  });

  it("flags suppressed emails in the response; the invoice still lands as Draft", async () => {
    await owner.consentEvent.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        channel: "email",
        value: "suppressed-doc@test.eva.local",
      },
    });
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6003", "Total: 10.00"]));
    const response = await confirm(staged.id, {
      invoiceNumber: "INV-6003",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "Sup Doc Co",
      contactEmail: "suppressed-doc@test.eva.local",
    }).expect(200);
    expect(response.body.suppressed).toBe(true);
    const invoice = await owner.invoice.findUniqueOrThrow({
      where: { id: response.body.invoice.id },
    });
    expect(invoice.status).toBe("draft");
    const audit = await owner.auditLog.findFirst({
      where: {
        organisationId: org.id,
        entityId: staged.id,
        action: "invoice_document.confirmed",
      },
    });
    expect(audit?.metadata).toMatchObject({ suppressed: true });
  });

  it("confirm from confirmed → 409; cancel from confirmed → 409", async () => {
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6004", "Total: 10.00"]));
    const body = {
      invoiceNumber: "INV-6004",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "Twice Doc Co",
    };
    await confirm(staged.id, body).expect(200);
    const response = await confirm(staged.id, body).expect(409);
    expect(response.body.message).toMatch(/confirmed/);
    await cancel(staged.id).expect(409);
  });

  it("cancel soft-deletes: subsequent access and confirm are 404", async () => {
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6005", "Total: 10.00"]));
    await cancel(staged.id).expect(200);
    const document = await owner.invoiceDocument.findUniqueOrThrow({ where: { id: staged.id } });
    expect(document.deletedAt).not.toBeNull();
    const audit = await owner.auditLog.findFirst({
      where: {
        organisationId: org.id,
        entityId: staged.id,
        action: "invoice_document.cancelled",
      },
    });
    expect(audit).toBeDefined();

    await request(app.getHttpServer())
      .get(`${baseUrl()}/${staged.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${baseUrl()}/${staged.id}/file`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(404);
    await confirm(staged.id, {
      invoiceNumber: "INV-6005",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "Gone Co",
    }).expect(404);
    // Cancelled documents are absent from the list.
    const list = await request(app.getHttpServer())
      .get(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect((list.body as { id: string }[]).some((d) => d.id === staged.id)).toBe(false);
  });

  it("rejects invalid confirm bodies → 400 (zod, same rules as 1.2/1.3)", async () => {
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6006", "Total: 10.00"]));
    // Missing both customer keys (the 1.3 refine).
    await confirm(staged.id, {
      invoiceNumber: "INV-6006",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
    }).expect(400);
    // Non-ISO date.
    await confirm(staged.id, {
      invoiceNumber: "INV-6006",
      amountMinorUnits: 1000,
      dueDate: "31/08/2026",
      customerName: "Bad Date Co",
    }).expect(400);
    // Non-positive amount.
    await confirm(staged.id, {
      invoiceNumber: "INV-6006",
      amountMinorUnits: 0,
      dueDate: "2026-09-01",
      customerName: "Bad Amount Co",
    }).expect(400);
  });

  it("rejects confirm and cancel for read_only / sales (default matrix) → 403", async () => {
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6007", "Total: 10.00"]));
    await confirm(
      staged.id,
      {
        invoiceNumber: "INV-6007",
        amountMinorUnits: 1000,
        dueDate: "2026-09-01",
        customerName: "Perm Doc Co",
      },
      "read_only",
    ).expect(403);
    await cancel(staged.id, "sales").expect(403);
    const document = await owner.invoiceDocument.findUniqueOrThrow({ where: { id: staged.id } });
    expect(document.status).toBe("extracted");
    expect(document.deletedAt).toBeNull();
  });

  it("BRD 4.1 structural rule: confirmed invoices are ALWAYS draft — no active path", async () => {
    const staged = await upload(await pdfWithLines(["Invoice Number: INV-6008", "Total: 10.00"]));
    // Even a caller smuggling a status field gets it rejected by the strict
    // schema — and the invoice lands draft regardless.
    const response = await confirm(staged.id, {
      invoiceNumber: "INV-6008",
      amountMinorUnits: 1000,
      dueDate: "2026-09-01",
      customerName: "Structural Co",
    }).expect(200);
    const invoice = await owner.invoice.findUniqueOrThrow({
      where: { id: response.body.invoice.id },
    });
    expect(invoice.status).toBe("draft");
    // Activation stays the 1.2 per-invoice human action.
    const customer = await owner.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customer.id}/invoices/${invoice.id}/activate`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
  });
});
