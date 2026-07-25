import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
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
 * Imports confirm corrections (Slice 1.4 plan §7.9 — CSV/XLSX parity with the
 * PDF review-fix-save flow): an optional `{ corrections }` body on confirm is
 * merged over the staged raw values and re-validated per row. Rows without a
 * correction behave exactly as in 1.3.
 */

const HEADERS =
  "Invoice Number,Amount,Due Date,Customer Name,Customer Email,Contact Name,Contact Email";

function csvRows(...rows: string[]): Buffer {
  return Buffer.from([HEADERS, ...rows].join("\r\n"), "utf8");
}

describe("Imports: confirm corrections (Slice 1.4 plan §7.9)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();
  const memberByRole = new Map<string, { id: string }>();

  const baseUrl = () => `/organisations/${org.id}/imports`;

  async function upload(file: Buffer) {
    const response = await request(app.getHttpServer())
      .post(baseUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .attach("file", file, "ledger.csv")
      .expect(201);
    return response.body as { id: string; rows: { rowNumber: number; status: string }[] };
  }

  function confirm(importId: string, body?: object): request.Test {
    const req = request(app.getHttpServer())
      .post(`${baseUrl()}/${importId}/confirm`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`);
    return body === undefined ? req : req.send(body);
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "imports-corrections", ["owner", "finance"]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      memberByRole.set(member.roleKey, member);
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("a correction fixes an invalid row → imported; audit notes correctionsApplied", async () => {
    const staged = await upload(
      csvRows("FIX-1,not-a-number,01/09/2026,Fix Co,,,", "FIX-2,10.00,01/09/2026,Fix Co,,,"),
    );
    expect(staged.rows.map((row) => row.status)).toEqual(["invalid", "valid"]);

    const response = await confirm(staged.id, {
      corrections: { 1: { amount: "123.45" } },
    }).expect(200);
    expect(response.body.createdRows).toBe(2);
    expect(response.body.rows[0].status).toBe("imported");
    expect(response.body.rows[0].createdInvoiceId).not.toBeNull();

    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "FIX-1" },
    });
    expect(invoice.amountMinorUnits).toBe(12345);
    expect(invoice.status).toBe("draft");

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: staged.id, action: "import.completed" },
    });
    expect(audit?.metadata).toMatchObject({ correctionsApplied: 1 });
  });

  it("a correction making the number duplicate a live invoice → row duplicate, skipped", async () => {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Corr Dup Co",
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    await owner.invoice.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId: customer.id,
        invoiceNumber: "LIVE-99",
        amountMinorUnits: 100,
        issueDate: new Date(),
        dueDate: new Date(),
        createdBy: memberByRole.get("owner")!.id,
      },
    });
    const staged = await upload(csvRows("CD-1,10.00,01/09/2026,Corr Dup Co,,,"));
    expect(staged.rows[0]!.status).toBe("valid");
    const response = await confirm(staged.id, {
      corrections: { 1: { invoiceNumber: "LIVE-99" } },
    }).expect(200);
    expect(response.body.createdRows).toBe(0);
    expect(response.body.rows[0].status).toBe("duplicate");
    expect(response.body.rows[0].createdInvoiceId).toBeNull();
    // The pre-existing invoice is untouched (never upserted).
    const existing = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "LIVE-99" },
    });
    expect(existing.amountMinorUnits).toBe(100);
  });

  it("a still-invalid corrected row stays invalid with the NEW errors", async () => {
    const staged = await upload(csvRows("STILL-1,not-a-number,01/09/2026,Still Co,,,"));
    expect(staged.rows[0]!.status).toBe("invalid");
    const response = await confirm(staged.id, {
      corrections: { 1: { amount: "also-not-a-number" } },
    }).expect(200);
    expect(response.body.createdRows).toBe(0);
    expect(response.body.rows[0].status).toBe("invalid");
    expect(response.body.rows[0].errors.join(" ")).toMatch(/also-not-a-number/);
    expect(
      await owner.invoice.count({ where: { organisationId: org.id, invoiceNumber: "STILL-1" } }),
    ).toBe(0);
  });

  it("corrections on a customer field re-route resolution (auto-create the corrected name)", async () => {
    const staged = await upload(csvRows("REDIR-1,7.50,01/09/2026,,,,"));
    // No customer in the file → invalid at staging; corrected at confirm.
    expect(staged.rows[0]!.status).toBe("invalid");
    const response = await confirm(staged.id, {
      corrections: { 1: { customerName: "Corrected Customer Co" } },
    }).expect(200);
    expect(response.body.createdRows).toBe(1);
    const customer = await owner.customer.findFirstOrThrow({
      where: { organisationId: org.id, name: "Corrected Customer Co" },
    });
    const invoice = await owner.invoice.findFirstOrThrow({
      where: { organisationId: org.id, invoiceNumber: "REDIR-1" },
    });
    expect(invoice.customerId).toBe(customer.id);
  });

  it("no body and an empty corrections map behave exactly as 1.3 (unchanged)", async () => {
    const noBody = await upload(csvRows("NC-1,1.00,01/09/2026,NoCorr Co,,,"));
    const response = await confirm(noBody.id).expect(200);
    expect(response.body.createdRows).toBe(1);

    const empty = await upload(csvRows("NC-2,1.00,01/09/2026,NoCorr Co,,,"));
    const emptyResponse = await confirm(empty.id, { corrections: {} }).expect(200);
    expect(emptyResponse.body.createdRows).toBe(1);
    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: empty.id, action: "import.completed" },
    });
    expect(audit?.metadata).toMatchObject({ correctionsApplied: 0 });
  });

  it("corrections on a non-uploaded import → 409", async () => {
    const staged = await upload(csvRows("DONE-1,1.00,01/09/2026,Done Co,,,"));
    await confirm(staged.id).expect(200);
    await confirm(staged.id, { corrections: { 1: { amount: "2.00" } } }).expect(409);
  });

  it("rejects malformed corrections → 400", async () => {
    const staged = await upload(csvRows("MAL-1,1.00,01/09/2026,Mal Co,,,"));
    await confirm(staged.id, { corrections: { 1: { amount: 123 } } }).expect(400);
    await confirm(staged.id, { corrections: { notARow: { amount: "1.00" } } }).expect(400);
    await confirm(staged.id, { corrections: { 1: { unknownField: "x" } } }).expect(400);
  });
});
