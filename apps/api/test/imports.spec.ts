import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import ExcelJS from "exceljs";
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
import { autoMapHeaders } from "../src/modules/imports/import-mapping.js";
import { parseImportFile, sniffFileType } from "../src/modules/imports/import-parser.js";
import {
  normaliseImportCurrency,
  parseImportAmount,
  parseImportDate,
} from "../src/modules/imports/import-values.js";

/**
 * CSV/Excel invoice import (Slice 1.3) — parser units, upload security and
 * staging. Routes live at /organisations/:organisationId/imports.
 * Confirm/cancel coverage is in imports-confirm.spec.ts (each spec file gets
 * its own rate-limiter bucket, so request-heavy flows are split).
 */

const HEADERS =
  "Invoice Number,Amount,Due Date,Customer Name,Customer Email,Contact Name,Contact Email";

function csvRows(...rows: string[]): Buffer {
  return Buffer.from([HEADERS, ...rows].join("\r\n"), "utf8");
}

async function xlsxRows(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("Imports: parser adapter units (plan §6)", () => {
  it("sniffs xlsx from ZIP magic bytes regardless of filename", async () => {
    const buffer = await xlsxRows(["A"], [["1"]]);
    expect(sniffFileType(buffer)).toBe("xlsx");
  });

  it("sniffs plain text as csv", () => {
    expect(sniffFileType(csvRows("A-1,1.00,01/09/2026,Acme,,,"))).toBe("csv");
  });

  it("rejects legacy .xls (OLE2 magic) with a clear message", () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    expect(() => sniffFileType(xls)).toThrowError(/\.xls/);
  });

  it("rejects NUL bytes and invalid UTF-8 (wrong magic) → 422", () => {
    expect(() => sniffFileType(Buffer.from("a\x00b", "utf8"))).toThrowError(/UTF-8/);
    expect(() => sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toThrowError(
      /UTF-8/,
    );
  });

  it("parses CSV with BOM, CRLF and quoted fields containing commas", async () => {
    const buffer = Buffer.concat([
      Buffer.from("﻿", "utf8"),
      Buffer.from(`${HEADERS}\r\n"A-7","£1,234.56","01/09/2026","Acme, Ltd.",,,\r\n`, "utf8"),
    ]);
    const { headers, rows } = await parseImportFile(buffer, "csv");
    expect(headers[0]).toBe("Invoice Number");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["Customer Name"]).toBe("Acme, Ltd.");
    expect(rows[0]!["Amount"]).toBe("£1,234.56");
  });

  it("tolerates ragged rows (relax_column_count)", async () => {
    const buffer = Buffer.from(`${HEADERS}\r\nA-1,10.00,01/09/2026\r\n`, "utf8");
    const { rows } = await parseImportFile(buffer, "csv");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["Customer Name"]).toBe("");
  });

  it("parses XLSX first worksheet: header row + trimmed string cells", async () => {
    const buffer = await xlsxRows(
      ["Invoice Number", "Amount", "Due Date", "Customer Name"],
      [["X-1", "99.99", "2026-09-01", "  Xlsx Customer  "]],
    );
    const { headers, rows } = await parseImportFile(buffer, "xlsx");
    expect(headers).toEqual(["Invoice Number", "Amount", "Due Date", "Customer Name"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["Customer Name"]).toBe("Xlsx Customer");
  });

  it("rejects an empty file (no header row) → 422", async () => {
    await expect(parseImportFile(Buffer.from("", "utf8"), "csv")).rejects.toThrowError(/header/);
  });

  it("parses amounts to integer minor units: £1,234.56 → 123456", () => {
    expect(parseImportAmount("£1,234.56")).toBe(123456);
    expect(parseImportAmount("1234.56")).toBe(123456);
    expect(parseImportAmount("100")).toBe(10000);
    expect(parseImportAmount("0.01")).toBe(1);
  });

  it("rejects zero, negative, garbage and over-precise amounts", () => {
    expect(parseImportAmount("0")).toBeNull();
    expect(parseImportAmount("0.00")).toBeNull();
    expect(parseImportAmount("-5")).toBeNull();
    expect(parseImportAmount("abc")).toBeNull();
    expect(parseImportAmount("12.345")).toBeNull();
    expect(parseImportAmount("1,23.4")).toBeNull();
  });

  it("parses ISO and UK DD/MM/YYYY dates to UTC midnight", () => {
    expect(parseImportDate("2026-09-01")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseImportDate("01/09/2026")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseImportDate("1/9/2026")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rejects impossible and garbage dates", () => {
    expect(parseImportDate("31/02/2026")).toBeNull();
    expect(parseImportDate("2026-13-01")).toBeNull();
    expect(parseImportDate("next friday")).toBeNull();
    expect(parseImportDate("09/01/2026".replace(/\//g, "-"))).toBeNull(); // 09-01-2026 is neither form
  });

  it("normalises currency: default GBP, case-insensitive, 3 letters only", () => {
    expect(normaliseImportCurrency(undefined)).toBe("GBP");
    expect(normaliseImportCurrency("gbp")).toBe("GBP");
    expect(normaliseImportCurrency("EUR")).toBe("EUR");
    expect(normaliseImportCurrency("GB")).toBeNull();
    expect(normaliseImportCurrency("GBPX")).toBeNull();
  });

  it("auto-maps headers case-insensitively with normalisation", () => {
    const mapping = autoMapHeaders([
      "Invoice Number",
      "AMOUNT",
      "due_date",
      "  Customer  Name ",
      "Email",
      "Unrelated Column",
    ]);
    expect(mapping).toEqual({
      "Invoice Number": "invoiceNumber",
      AMOUNT: "amount",
      due_date: "dueDate",
      "  Customer  Name ": "customerName",
      Email: "customerEmail",
    });
  });

  it("auto-map lets the first header win a canonical field", () => {
    const mapping = autoMapHeaders(["Total", "Amount"]);
    expect(mapping).toEqual({ Total: "amount" });
  });
});

describe("Imports: upload, staging and validation", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();

  function upload(role: string, file: Buffer, filename = "ledger.csv", mapping?: object) {
    let req = request(app.getHttpServer())
      .post(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${tokens.get(role)}`)
      .attach("file", file, filename);
    if (mapping !== undefined) req = req.field("mapping", JSON.stringify(mapping));
    return req;
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "imports", [
      "owner",
      "finance",
      "sales",
      "reception",
      "read_only",
    ]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("uploads a CSV → 201 uploaded, mapping echoed, rows staged, audit-logged", async () => {
    const response = await upload(
      "finance",
      csvRows(
        "UP-1,123.45,01/09/2026,Upload Customer,ap@upload.test,Accounts,billing@upload.test",
        "UP-2,10.00,2026-09-02,Upload Customer,ap@upload.test,,",
      ),
    ).expect(201);
    expect(response.body).toMatchObject({
      originalFilename: "ledger.csv",
      fileType: "csv",
      status: "uploaded",
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      createdRows: 0,
    });
    expect(response.body.mapping).toMatchObject({
      "Invoice Number": "invoiceNumber",
      Amount: "amount",
      "Due Date": "dueDate",
      "Customer Name": "customerName",
      "Customer Email": "customerEmail",
      "Contact Name": "contactName",
      "Contact Email": "contactEmail",
    });
    expect(response.body.rows).toHaveLength(2);
    expect(response.body.rows[0]).toMatchObject({
      rowNumber: 1,
      status: "valid",
      createdInvoiceId: null,
    });
    // Auto-create flag (plan §7.2) rides in the row's messages.
    expect(response.body.rows[0].errors.join(" ")).toMatch(/will be created on confirm/);
    expect(response.body.rows[0].raw).toMatchObject({ "Invoice Number": "UP-1" });

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityType: "import", entityId: response.body.id },
    });
    expect(audit?.action).toBe("import.uploaded");
    // Counts only — never amounts or customer detail (BRD 14).
    expect(audit?.metadata).toMatchObject({ fileType: "csv", totalRows: 2, validRows: 2 });
    expect(JSON.stringify(audit?.metadata)).not.toContain("123.45");
    expect(JSON.stringify(audit?.metadata)).not.toContain("UP-1");
  });

  it("honours an explicit mapping form field", async () => {
    const buffer = Buffer.from("Ref,Sum,Deadline,Client\nM-1,5.00,01/09/2026,Mapped Co\n", "utf8");
    const response = await upload("finance", buffer, "mapped.csv", {
      Ref: "invoiceNumber",
      Sum: "amount",
      Deadline: "dueDate",
      Client: "customerName",
    }).expect(201);
    expect(response.body.mapping).toEqual({
      Ref: "invoiceNumber",
      Sum: "amount",
      Deadline: "dueDate",
      Client: "customerName",
    });
    expect(response.body.rows[0].status).toBe("valid");
  });

  it("rejects a malformed mapping (bad JSON, unknown column, duplicate field, bad field) → 400", async () => {
    const buffer = csvRows("BAD-1,1.00,01/09/2026,Bad Co,,,");
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .attach("file", buffer, "bad.csv")
      .field("mapping", "{not json")
      .expect(400);
    await upload("finance", buffer, "bad.csv", { "No Such Column": "amount" }).expect(400);
    await upload("finance", buffer, "bad.csv", {
      Amount: "amount",
      "Invoice Number": "amount",
    }).expect(400);
    await upload("finance", buffer, "bad.csv", { Amount: "notAField" }).expect(400);
  });

  it("flags rows invalid when required canonical fields are unmapped", async () => {
    const buffer = Buffer.from("Invoice Number,Customer Name\nNOAMT-1,No Amount Co\n", "utf8");
    const response = await upload("finance", buffer).expect(201);
    expect(response.body.invalidRows).toBe(1);
    expect(response.body.rows[0].status).toBe("invalid");
    expect(response.body.rows[0].errors.join(" ")).toMatch(/amount/);
    // dueDate is also unmapped → reported too.
    expect(response.body.rows[0].errors.join(" ")).toMatch(/dueDate/);
  });

  it("surfaces per-row semantic errors in the preview", async () => {
    const response = await upload(
      "finance",
      csvRows(
        "SEM-1,not-a-number,01/09/2026,Semantic Co,,,",
        "SEM-2,10.00,32/13/2026,Semantic Co,,,",
        ",10.00,01/09/2026,Semantic Co,,,",
        "SEM-4,10.00,01/09/2026,,,,",
        "SEM-5,10.00,01/09/2026,Semantic Co,not-an-email,,",
      ),
    ).expect(201);
    const rows = response.body.rows as { status: string; errors: string[] }[];
    expect(rows.every((row) => row.status === "invalid")).toBe(true);
    expect(rows[0]!.errors.join(" ")).toMatch(/amount/);
    expect(rows[1]!.errors.join(" ")).toMatch(/dueDate/);
    expect(rows[2]!.errors.join(" ")).toMatch(/invoiceNumber/);
    expect(rows[3]!.errors.join(" ")).toMatch(/customerReference or customerName/);
    expect(rows[4]!.errors.join(" ")).toMatch(/customerEmail/);
    expect(response.body.validRows).toBe(0);
    expect(response.body.invalidRows).toBe(5);
  });

  it("detects duplicates against live invoices in the org", async () => {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Dup Customer",
        createdBy: org.members[0]!.id,
      },
    });
    await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        invoiceNumber: "DUP-LIVE-1",
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
        createdBy: org.members[0]!.id,
      },
    });
    const response = await upload(
      "finance",
      csvRows("DUP-LIVE-1,10.00,01/09/2026,Dup Customer,,,"),
    ).expect(201);
    expect(response.body.duplicateRows).toBe(1);
    expect(response.body.rows[0].status).toBe("duplicate");
  });

  it("treats a soft-deleted invoice number as reusable (the 0006 index)", async () => {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Reuse Customer",
        createdBy: org.members[0]!.id,
      },
    });
    await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        invoiceNumber: "DUP-DELETED-1",
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
        deletedAt: new Date(),
        createdBy: org.members[0]!.id,
      },
    });
    const response = await upload(
      "finance",
      csvRows("DUP-DELETED-1,10.00,01/09/2026,Reuse Customer,,,"),
    ).expect(201);
    expect(response.body.rows[0].status).toBe("valid");
  });

  it("within-file duplicates: the first occurrence stands, the rest are skipped (plan §7.3)", async () => {
    const response = await upload(
      "finance",
      csvRows(
        "WF-1,10.00,01/09/2026,WithinFile Co,,,",
        "WF-1,20.00,02/09/2026,WithinFile Co,,,",
        "WF-1,30.00,03/09/2026,WithinFile Co,,,",
      ),
    ).expect(201);
    const statuses = response.body.rows.map((row: { status: string }) => row.status);
    expect(statuses).toEqual(["valid", "skipped", "skipped"]);
    expect(response.body.validRows).toBe(1);
  });

  it("resolves customers by reference and by case-insensitive exact name", async () => {
    await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Reference Customer",
        reference: "REF-9001",
        createdBy: org.members[0]!.id,
      },
    });
    const buffer = Buffer.from(
      "Invoice Number,Amount,Due Date,Customer Reference\r\nREFM-1,10.00,01/09/2026,REF-9001\r\n",
      "utf8",
    );
    const byReference = await upload("finance", buffer).expect(201);
    // Matched → no auto-create flag.
    expect(byReference.body.rows[0].status).toBe("valid");
    expect(byReference.body.rows[0].errors.join(" ")).not.toMatch(/will be created/);

    await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Case Customer Ltd",
        createdBy: org.members[0]!.id,
      },
    });
    const byName = await upload(
      "finance",
      csvRows("NM-1,10.00,01/09/2026,case customer ltd,,,"),
    ).expect(201);
    expect(byName.body.rows[0].status).toBe("valid");
    expect(byName.body.rows[0].errors.join(" ")).not.toMatch(/will be created/);
  });

  it("flags ambiguous customer name matches as invalid — never guesses (plan §7.2)", async () => {
    for (let i = 0; i < 2; i++) {
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Ambiguous Ltd",
          createdBy: org.members[0]!.id,
        },
      });
    }
    const response = await upload(
      "finance",
      csvRows("AMB-1,10.00,01/09/2026,Ambiguous Ltd,,,"),
    ).expect(201);
    expect(response.body.rows[0].status).toBe("invalid");
    expect(response.body.rows[0].errors.join(" ")).toMatch(/ambiguous/);
  });

  it("flags suppressed contact and customer emails (BRD hard rule); rows stay importable (§7.4)", async () => {
    await owner.suppressionEntry.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        channel: "email",
        value: "suppressed-contact@test.eva.local",
      },
    });
    await owner.suppressionEntry.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        channel: "email",
        value: "suppressed-customer@test.eva.local",
      },
    });
    const response = await upload(
      "finance",
      csvRows(
        "SUP-1,10.00,01/09/2026,Sup Co One,,Accounts,suppressed-contact@test.eva.local",
        "SUP-2,10.00,01/09/2026,Sup Co Two,suppressed-customer@test.eva.local,,",
        "SUP-3,10.00,01/09/2026,Sup Co Three,clean@test.eva.local,,",
      ),
    ).expect(201);
    const statuses = response.body.rows.map((row: { status: string }) => row.status);
    expect(statuses).toEqual(["suppressed", "suppressed", "valid"]);
    expect(response.body.suppressedRows).toBe(2);
  });

  it("uploads an XLSX file (type from magic bytes, not the filename)", async () => {
    const buffer = await xlsxRows(
      ["Invoice Number", "Amount", "Due Date", "Customer Name"],
      [["XLS-1", "99.99", "2026-09-01", "Xlsx Upload Co"]],
    );
    // Deliberately misleading filename — sniffing must win (BRD 15).
    const response = await upload("finance", buffer, "misleading.csv").expect(201);
    expect(response.body.fileType).toBe("xlsx");
    expect(response.body.rows[0].status).toBe("valid");
  });

  it("rejects legacy .xls and wrong-magic files → 422", async () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4]);
    await upload("finance", xls, "old.xls").expect(422);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    await upload("finance", png, "image.csv").expect(422);
    await upload("finance", Buffer.from("a\x00b\x00c", "utf8"), "nul.csv").expect(422);
  });

  it("rejects files over 5 MB → 413", async () => {
    const huge = Buffer.concat([
      Buffer.from(`${HEADERS}\r\n`, "utf8"),
      Buffer.alloc(5 * 1024 * 1024, 0x61),
    ]);
    await upload("finance", huge, "huge.csv").expect(413);
  });

  it("rejects files over 1,000 data rows → 422", async () => {
    const lines = [HEADERS];
    for (let i = 1; i <= 1_001; i++) lines.push(`CAP-${i},1.00,01/09/2026,Cap Co,,,`);
    await upload("finance", Buffer.from(lines.join("\r\n"), "utf8"), "cap.csv").expect(422);
  });

  it("requires a file field → 400", async () => {
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(400);
  });

  it("rejects upload as sales / reception / read_only (default read-only) → 403", async () => {
    for (const role of ["sales", "reception", "read_only"]) {
      await upload(role, csvRows("P-1,1.00,01/09/2026,Perm Co,,,")).expect(403);
    }
  });

  it("reads (list + detail) as read_only; never writes audit entries on reads", async () => {
    const created = await upload("finance", csvRows("RO-1,1.00,01/09/2026,ReadOnly Co,,,")).expect(
      201,
    );
    const before = await owner.auditLog.count({
      where: { organisationId: org.id, entityType: "import" },
    });

    const list = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(list.body.some((i: { id: string }) => i.id === created.body.id)).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/imports/${created.body.id}`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(detail.body.id).toBe(created.body.id);
    expect(detail.body.rows).toHaveLength(1);

    const after = await owner.auditLog.count({
      where: { organisationId: org.id, entityType: "import" },
    });
    expect(after).toBe(before);
  });

  it("lists imports newest first", async () => {
    const first = await upload("finance", csvRows("ORD-1,1.00,01/09/2026,Order Co,,,")).expect(201);
    const second = await upload("finance", csvRows("ORD-2,1.00,01/09/2026,Order Co,,,")).expect(
      201,
    );
    const list = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    const ids = list.body.map((i: { id: string }) => i.id);
    expect(ids.indexOf(second.body.id)).toBeLessThan(ids.indexOf(first.body.id));
  });

  it("returns 404 for another tenant on every route", async () => {
    const mine = await upload("finance", csvRows("XT-1,1.00,01/09/2026,CrossTenant Co,,,")).expect(
      201,
    );
    const otherOrg = await createOrgWithMembers(owner, "imports-other", ["owner", "finance"]);
    const otherToken = await signToken({
      sub: otherOrg.members[0]!.authUserId,
      email: otherOrg.members[0]!.email,
    });

    // Other tenant's caller cannot touch my org at all (404, never 403).
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${otherToken}`)
      .attach("file", csvRows("XT-2,1.00,01/09/2026,XT Co,,,"), "x.csv")
      .expect(404);
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/imports`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    // My import id under the other org is invisible.
    await request(app.getHttpServer())
      .get(`/organisations/${otherOrg.id}/imports/${mine.body.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/organisations/${otherOrg.id}/imports/${mine.body.id}/confirm`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/organisations/${otherOrg.id}/imports/${mine.body.id}/cancel`)
      .set("Authorization", `Bearer ${otherToken}`)
      .expect(404);
  });

  it("org permission override grants sales imports:write and revokes finance", async () => {
    const grants = [
      ...["customers:read", "customers:write", "permissions:read", "permissions:manage"].map(
        (permissionKey) => ({ roleKey: "owner", permissionKey }),
      ),
      { roleKey: "owner", permissionKey: "imports:read" },
      { roleKey: "owner", permissionKey: "imports:write" },
      { roleKey: "finance", permissionKey: "imports:read" },
      { roleKey: "sales", permissionKey: "imports:read" },
      { roleKey: "sales", permissionKey: "imports:write" },
    ];
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants })
      .expect(200);

    await upload("sales", csvRows("OV-1,1.00,01/09/2026,Override Co,,,")).expect(201);
    await upload("finance", csvRows("OV-2,1.00,01/09/2026,Override Co,,,")).expect(403);

    // Reset to the BRD default matrix.
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants: [] })
      .expect(200);
  });
});
