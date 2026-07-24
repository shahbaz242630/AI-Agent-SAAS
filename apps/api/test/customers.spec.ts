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
  type FixtureUser,
} from "./support.js";

/**
 * Customers CRUD + permissions (Slice 1.1). All routes live under
 * /organisations/:organisationId/customers.
 */

describe("Customers: CRUD and permissions", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  const tokens = new Map<string, string>();

  const membersByRole = new Map<string, FixtureUser>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "customers", [
      "owner",
      "finance",
      "sales",
      "read_only",
    ]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      membersByRole.set(member.roleKey, member);
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  async function createFixtureCustomer(name: string, orgId = org.id) {
    const id = randomUUID();
    await owner.customer.create({
      data: { id, organisationId: orgId, name, createdBy: membersByRole.get("owner")!.id },
    });
    return id;
  }

  it("creates a customer as finance (default write) → 201, audit-logged", async () => {
    const response = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ name: "Acme Plc", email: "ACCOUNTs@acme.test", phone: "+44 20 7946 0000" })
      .expect(201);

    expect(response.body).toMatchObject({
      name: "Acme Plc",
      email: "accounts@acme.test",
      phone: "+44 20 7946 0000",
    });
    customerId = response.body.id;

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityType: "customer", entityId: customerId },
    });
    expect(audit?.action).toBe("customer.created");
  });

  it("rejects create as sales (default read-only) → 403", async () => {
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("sales")}`)
      .send({ name: "Badger Ltd" })
      .expect(403);
  });

  it("rejects create with empty name or bad email → 400", async () => {
    const token = tokens.get("finance")!;
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "   " })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Badger Ltd", email: "not-an-email" })
      .expect(400);
  });

  it("lists customers as read_only and excludes soft-deleted ones", async () => {
    const toDelete = await createFixtureCustomer("Soon Gone Ltd");
    await owner.customer.update({ where: { id: toDelete }, data: { deletedAt: new Date() } });

    const response = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(response.body.map((c: { id: string }) => c.id)).not.toContain(toDelete);
    expect(response.body.some((c: { id: string }) => c.id === customerId)).toBe(true);
  });

  it("returns 404 when caller is not a member", async () => {
    const outsider = await signToken({
      sub: randomUUID(),
      email: "customers.outsider@test.eva.local",
    });
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${outsider}`)
      .expect(404);
  });

  it("cross-tenant customer access returns 404, not 403", async () => {
    const otherOrg = await createOrgWithMembers(owner, "customers-other", ["owner"]);
    const otherCustomer = await createFixtureCustomer("Other Org Customer", otherOrg.id);

    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${otherCustomer}`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(404);
  });

  it("updates a customer as finance → 200, audit-logged", async () => {
    const response = await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/customers/${customerId}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ name: "Acme Plc Updated" })
      .expect(200);
    expect(response.body.name).toBe("Acme Plc Updated");

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: customerId, action: "customer.updated" },
    });
    expect(audit).toBeDefined();
  });

  it("soft-deletes a customer as finance → 200, audit-logged, subsequent reads 404", async () => {
    await request(app.getHttpServer())
      .delete(`/organisations/${org.id}/customers/${customerId}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${customerId}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(404);

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: customerId, action: "customer.deleted" },
    });
    expect(audit).toBeDefined();
  });

  it("does not write audit logs for read operations", async () => {
    const before = await owner.auditLog.count({ where: { organisationId: org.id } });
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);
    const after = await owner.auditLog.count({ where: { organisationId: org.id } });
    expect(after).toBe(before);
  });
});

/**
 * Direct end-to-end of the data-driven permission guard using the permissions
 * API to flip the CRM write role from finance to sales.
 */
describe("Customers: permissions become data-driven", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "perm-flip", ["owner", "finance", "sales"]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("sales cannot create until owner grants the permission", async () => {
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("sales")}`)
      .send({ name: "Sales Customer" })
      .expect(403);

    // Grant sales customers:write; keep finance's existing rights.
    const get = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(200);

    const grants = get.body.grants.filter(
      (g: { roleKey: string; permissionKey: string }) =>
        !(g.roleKey === "sales" && g.permissionKey === "customers:write"),
    );
    grants.push({ roleKey: "sales", permissionKey: "customers:write" });

    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("sales")}`)
      .send({ name: "Sales Customer" })
      .expect(201);
  });
});
