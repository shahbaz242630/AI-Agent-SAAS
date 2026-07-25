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
 * PDF invoice extraction (Slice 1.4) — upload security, the rule-based
 * extractor against real generated PDFs (plan §7.4 — no mocks), the review
 * payload, the file endpoint, authz and tenant isolation. Confirm/cancel
 * coverage is in invoice-documents-confirm.spec.ts (each spec file gets its
 * own rate-limiter bucket, so request-heavy flows are split).
 * Fixtures are real text-layer PDFs generated in-test with pdfkit.
 */

/** Builds a real text-layer PDF: one line of text per entry. */
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

/** A PDF with NO text layer (a scanned-document stand-in, plan §8 risk 1). */
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

const LABELLED_INVOICE = [
  "Acme Widgets Ltd",
  "Invoice Number: INV-1042",
  "Invoice Date: 01/08/2026",
  "Due Date: 31/08/2026",
  "Bill To: Beta Trading Co",
  "Customer Reference: BT-100",
  "Contact: Jane Doe",
  "Customer Email: ap@beta.test",
  "Subtotal: £1,000.00",
  "Total Due: £1,234.56",
];

describe("Invoice documents: upload, extraction and review payload", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();

  const baseUrl = () => `/organisations/${org.id}/invoice-documents`;

  function upload(role: string, file: Buffer, filename = "invoice.pdf") {
    return request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .attach("file", file, filename);
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "invdocs", ["owner", "finance", "sales", "read_only"]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("uploads a labelled PDF → 201 extracted, per-field confidence, audit trail", async () => {
    const response = await upload("finance", await pdfWithLines(LABELLED_INVOICE)).expect(201);
    expect(response.body).toMatchObject({
      originalFilename: "invoice.pdf",
      status: "extracted",
      extractionError: null,
      invoiceId: null,
    });
    // The PDF bytes are NEVER in JSON responses (plan §3 — file endpoint only).
    expect(response.body.content).toBeUndefined();
    expect(response.body.sizeBytes).toBeGreaterThan(0);

    // Exact label + adjacent value → 0.9 (plan §3).
    const fields = response.body.extractedFields as Record<
      string,
      { value: string | null; confidence: number }
    >;
    expect(fields.invoiceNumber).toEqual({ value: "INV-1042", confidence: 0.9 });
    expect(fields.issueDate).toEqual({ value: "01/08/2026", confidence: 0.9 });
    expect(fields.dueDate).toEqual({ value: "31/08/2026", confidence: 0.9 });
    expect(fields.amount).toEqual({ value: "£1,234.56", confidence: 0.9 });
    expect(fields.currency).toEqual({ value: "GBP", confidence: 0.9 });
    expect(fields.customerName).toEqual({ value: "Beta Trading Co", confidence: 0.9 });
    expect(fields.customerReference).toEqual({ value: "BT-100", confidence: 0.9 });
    expect(fields.contactName).toEqual({ value: "Jane Doe", confidence: 0.9 });
    expect(fields.customerEmail).toEqual({ value: "ap@beta.test", confidence: 0.9 });

    const audits = await owner.auditLog.findMany({
      where: { organisationId: org.id, entityType: "invoice_document", entityId: response.body.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((audit) => audit.action)).toEqual([
      "invoice_document.uploaded",
      "invoice_document.extracted",
    ]);
    // Counts/sizes only — never amounts or content (BRD 14).
    expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain("1,234.56");
    expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain("INV-1042");
  });

  it("fuzzy layout → lower confidence; missing required fields flagged for review", async () => {
    const response = await upload(
      "finance",
      await pdfWithLines(["ACME WIDGETS", "INV-2099", "Payment of 450.00", "1,250.75"]),
    ).expect(201);
    const fields = response.body.extractedFields as Record<
      string,
      { value: string | null; confidence: number }
    >;
    // Found without a label → 0.5; largest-amount tiebreak (plan §3).
    expect(fields.invoiceNumber).toEqual({ value: "INV-2099", confidence: 0.5 });
    expect(fields.amount).toEqual({ value: "1,250.75", confidence: 0.5 });
    // Never seen → absent (the review payload flags it as missing).
    expect(fields.dueDate).toBeUndefined();
    expect(fields.customerName).toBeUndefined();
    // No currency evidence → absent; confirm defaults GBP (1.3 semantics).
    expect(fields.currency).toBeUndefined();
  });

  it("label found but no value → present with value null + confidence 0", async () => {
    const response = await upload(
      "finance",
      await pdfWithLines(["Invoice Number: INV-3000", "Due Date:", "Total: 10.00"]),
    ).expect(201);
    const fields = response.body.extractedFields as Record<
      string,
      { value: string | null; confidence: number }
    >;
    expect(fields.dueDate).toEqual({ value: null, confidence: 0 });
  });

  it("parses ISO and UK dates, plain decimals and the largest amount", async () => {
    const response = await upload(
      "finance",
      await pdfWithLines([
        "Invoice Number: INV-1043",
        "Due Date: 2026-09-15",
        "Subtotal: 999.99",
        "Total: 1,000.01",
      ]),
    ).expect(201);
    const fields = response.body.extractedFields as Record<
      string,
      { value: string | null; confidence: number }
    >;
    expect(fields.dueDate?.value).toBe("2026-09-15");
    expect(fields.amount?.value).toBe("1,000.01");

    const uk = await upload(
      "finance",
      await pdfWithLines(["Invoice Number: INV-1044", "Due Date: 15/09/2026", "Total: 50.00"]),
    ).expect(201);
    expect(
      (uk.body.extractedFields as Record<string, { value: string | null }>).dueDate?.value,
    ).toBe("15/09/2026");
  });

  it("unknown currency symbol → noted, currency defaults GBP", async () => {
    const response = await upload(
      "finance",
      await pdfWithLines(["Invoice Number: INV-1045", "Due Date: 2026-09-15", "Total: ¥500.00"]),
    ).expect(201);
    const fields = response.body.extractedFields as Record<
      string,
      { value: string | null; confidence: number }
    >;
    expect(fields.amount?.value).toBe("¥500.00");
    expect(fields.currency).toEqual({ value: "GBP", confidence: 0.5 });
    expect((response.body.extractionNotes as string[]).join(" ")).toMatch(
      /unrecognised currency symbol/,
    );
  });

  it("multi-invoice PDF → first number wins with a note (one invoice per PDF, §7.3)", async () => {
    const response = await upload(
      "finance",
      await pdfWithLines([
        "Invoice Number: INV-1",
        "Total: 10.00",
        "Invoice Number: INV-2",
        "Total: 20.00",
      ]),
    ).expect(201);
    const fields = response.body.extractedFields as Record<
      string,
      { value: string | null; confidence: number }
    >;
    expect(fields.invoiceNumber?.value).toBe("INV-1");
    expect((response.body.extractionNotes as string[]).join(" ")).toMatch(
      /multiple invoice numbers/,
    );
  });

  it("no text layer → failed with the scanned-document message; retry stays failed", async () => {
    const response = await upload("finance", await pdfWithoutText(), "scan.pdf").expect(201);
    expect(response.body.status).toBe("failed");
    expect(response.body.extractionError).toMatch(/scanned document/);
    expect(response.body.extractionError).toMatch(/enter the details manually/);
    expect(response.body.extractedFields).toBeNull();

    const audits = await owner.auditLog.findMany({
      where: { organisationId: org.id, entityType: "invoice_document", entityId: response.body.id },
    });
    expect(audits.map((audit) => audit.action)).toContain("invoice_document.extraction_failed");

    // The retry endpoint re-runs extraction (plan §3) — same outcome here.
    const retried = await request(app.getHttpServer())
      .post(`${baseUrl()}/${response.body.id}/extract`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
    expect(retried.body.status).toBe("failed");
  });

  it("re-extract from extracted re-runs and stays extracted", async () => {
    const created = await upload("finance", await pdfWithLines(LABELLED_INVOICE)).expect(201);
    const retried = await request(app.getHttpServer())
      .post(`${baseUrl()}/${created.body.id}/extract`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
    expect(retried.body.status).toBe("extracted");
    expect(retried.body.extractedFields.invoiceNumber.value).toBe("INV-1042");
  });

  it("rejects non-PDF magic (PNG, .pdf-named garbage) → 422", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    await upload("finance", png, "image.pdf").expect(422);
    await upload("finance", Buffer.from("not a pdf at all", "utf8"), "garbage.pdf").expect(422);
  });

  it("rejects files over 10 MB → 413", async () => {
    const huge = Buffer.concat([
      Buffer.from("%PDF-", "utf8"),
      Buffer.alloc(10 * 1024 * 1024, 0x61),
    ]);
    await upload("finance", huge, "huge.pdf").expect(413);
  });

  it("requires a file field → 400; unauthenticated → 401", async () => {
    await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(400);
    await request(app.getHttpServer())
      .post(baseUrl())
      .attach("file", await pdfWithLines(["Invoice Number: INV-1"]), "invoice.pdf")
      .expect(401);
  });

  it("rejects upload/extract as sales and read_only (default matrix) → 403", async () => {
    const created = await upload("finance", await pdfWithLines(LABELLED_INVOICE)).expect(201);
    for (const role of ["sales", "read_only"]) {
      await upload(role, await pdfWithLines(["Invoice Number: INV-1"])).expect(403);
      await request(app.getHttpServer())
        .post(`${baseUrl()}/${created.body.id}/extract`)
        .set("Authorization", `Bearer ${tokens.get(role)}`)
        .expect(403);
    }
  });

  it("reads (list + detail) as read_only; reads never write audit entries", async () => {
    const created = await upload("finance", await pdfWithLines(LABELLED_INVOICE)).expect(201);
    const before = await owner.auditLog.count({
      where: { organisationId: org.id, entityType: "invoice_document" },
    });

    const list = await request(app.getHttpServer())
      .get(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    const mine = (list.body as { id: string; content?: unknown }[]).find(
      (document) => document.id === created.body.id,
    );
    expect(mine).toBeDefined();
    expect(mine?.content).toBeUndefined();

    const detail = await request(app.getHttpServer())
      .get(`${baseUrl()}/${created.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(detail.body.status).toBe("extracted");
    expect(detail.body.content).toBeUndefined();

    const after = await owner.auditLog.count({
      where: { organisationId: org.id, entityType: "invoice_document" },
    });
    expect(after).toBe(before);
  });

  it("streams the stored PDF from the file endpoint (tenant-scoped)", async () => {
    const pdf = await pdfWithLines(LABELLED_INVOICE);
    const created = await upload("finance", pdf).expect(201);
    const response = await request(app.getHttpServer())
      .get(`${baseUrl()}/${created.body.id}/file`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.compare(response.body as Buffer, pdf)).toBe(0);
  });

  it("returns 404 for another tenant on every route — never 403", async () => {
    const mine = await upload("finance", await pdfWithLines(LABELLED_INVOICE)).expect(201);
    const otherOrg = await createOrgWithMembers(owner, "invdocs-other", ["owner", "finance"]);
    const otherToken = await signToken({
      sub: otherOrg.members[0]!.authUserId,
      email: otherOrg.members[0]!.email,
    });

    await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${otherToken}`)
      .attach("file", await pdfWithLines(["Invoice Number: XT-1"]), "x.pdf")
      .expect(404);
    await request(app.getHttpServer())
      .get(baseUrl())
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    const otherBase = `/organisations/${otherOrg.id}/invoice-documents`;
    await request(app.getHttpServer())
      .get(`${otherBase}/${mine.body.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${otherBase}/${mine.body.id}/file`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`${otherBase}/${mine.body.id}/extract`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`${otherBase}/${mine.body.id}/confirm`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({
        invoiceNumber: "XT-9",
        amountMinorUnits: 100,
        dueDate: "2026-09-01",
        customerName: "Cross Tenant Co",
      })
      .expect(404);
    await request(app.getHttpServer())
      .post(`${otherBase}/${mine.body.id}/cancel`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
  });
});
