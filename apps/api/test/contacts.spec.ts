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
 * Contacts CRUD (Slice 1.1). Routes are nested under
 * /organisations/:organisationId/customers/:customerId/contacts.
 */
describe("Contacts: CRUD and permissions", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let customerId: string;
  let contactId: string;
  const tokens = new Map<string, string>();
  const membersByRole = new Map<string, FixtureUser>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "contacts", ["owner", "finance", "sales", "read_only"]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      membersByRole.set(member.roleKey, member);
    }
    customerId = (
      await owner.customer.create({
        data: {
          id: randomUUID(),
          organisationId: org.id,
          name: "Acme Plc",
          createdBy: membersByRole.get("owner")!.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("creates a contact as finance (default write) → 201, audit-logged", async () => {
    const response = await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customerId}/contacts`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ name: "Jane Doe", email: "Jane@acme.test", jobTitle: "Accounts" })
      .expect(201);

    expect(response.body).toMatchObject({
      name: "Jane Doe",
      email: "jane@acme.test",
      jobTitle: "Accounts",
    });
    contactId = response.body.id;

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityType: "contact", entityId: contactId },
    });
    expect(audit?.action).toBe("contact.created");
  });

  it("rejects create as sales (default read-only) → 403", async () => {
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customerId}/contacts`)
      .set("Authorization", `Bearer ${tokens.get("sales")}`)
      .send({ name: "Badger" })
      .expect(403);
  });

  it("rejects create with empty name or bad email → 400", async () => {
    const token = tokens.get("finance")!;
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customerId}/contacts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "   " })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers/${customerId}/contacts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Badger", email: "not-an-email" })
      .expect(400);
  });

  it("lists contacts as read_only and excludes soft-deleted ones", async () => {
    const toDelete = await owner.contact.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        customerId,
        name: "Soon Gone",
        createdBy: membersByRole.get("owner")!.id,
      },
    });
    await owner.contact.update({ where: { id: toDelete.id }, data: { deletedAt: new Date() } });

    const response = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${customerId}/contacts`)
      .set("Authorization", `Bearer ${tokens.get("read_only")}`)
      .expect(200);
    expect(response.body.map((c: { id: string }) => c.id)).not.toContain(toDelete.id);
    expect(response.body.some((c: { id: string }) => c.id === contactId)).toBe(true);
  });

  it("returns 404 when the customer belongs to another tenant", async () => {
    const otherOrg = await createOrgWithMembers(owner, "contacts-other", ["owner"]);
    const otherCustomer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: otherOrg.id,
        name: "Other Customer",
        createdBy: otherOrg.members[0]!.id,
      },
    });

    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${otherCustomer.id}/contacts`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(404);
  });

  it("returns 404 for a contact under a different customer in the same org", async () => {
    const otherCustomer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: "Sibling Customer",
        createdBy: membersByRole.get("owner")!.id,
      },
    });
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${otherCustomer.id}/contacts/${contactId}`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(404);
  });

  it("updates a contact as finance → 200, audit-logged", async () => {
    const response = await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/customers/${customerId}/contacts/${contactId}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ jobTitle: "Head of Accounts" })
      .expect(200);
    expect(response.body.jobTitle).toBe("Head of Accounts");

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: contactId, action: "contact.updated" },
    });
    expect(audit).toBeDefined();
  });

  it("soft-deletes a contact as finance → 200, audit-logged, subsequent reads 404", async () => {
    await request(app.getHttpServer())
      .delete(`/organisations/${org.id}/customers/${customerId}/contacts/${contactId}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/customers/${customerId}/contacts/${contactId}`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(404);

    const audit = await owner.auditLog.findFirst({
      where: { organisationId: org.id, entityId: contactId, action: "contact.deleted" },
    });
    expect(audit).toBeDefined();
  });
});
