import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ROLE_PERMISSIONS, ORGANISATION_ROLES, PERMISSION_KEYS } from "@eva/types";
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
 * Role→permission mapping API (Slice 1.1). Routes:
 *   GET /organisations/:id/permissions
 *   PUT /organisations/:id/permissions
 */
describe("Role permissions: view and edit", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "permissions", [
      "owner",
      "administrator",
      "finance",
      "sales",
    ]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("GET returns BRD default matrix for an org with no custom rows", async () => {
    const response = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(200);

    expect(response.body.source).toBe("default");
    const expectedGrants = ORGANISATION_ROLES.flatMap((roleKey) =>
      DEFAULT_ROLE_PERMISSIONS[roleKey].map((permissionKey) => ({ roleKey, permissionKey })),
    );
    expect(response.body.grants).toEqual(expectedGrants);
  });

  it("GET permissions:read is denied to finance by default → 403", async () => {
    await request(app.getHttpServer())
      .get(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .expect(403);
  });

  it("PUT permissions:manage is denied to finance → 403", async () => {
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ grants: [] })
      .expect(403);
  });

  it("PUT replaces the mapping and it takes effect immediately", async () => {
    // Finance loses customers:write; sales gains it.
    const grants = [
      { roleKey: "owner", permissionKey: "customers:write" },
      { roleKey: "owner", permissionKey: "customers:read" },
      { roleKey: "owner", permissionKey: "contacts:read" },
      { roleKey: "owner", permissionKey: "contacts:write" },
      { roleKey: "owner", permissionKey: "permissions:read" },
      { roleKey: "owner", permissionKey: "permissions:manage" },
      { roleKey: "administrator", permissionKey: "customers:read" },
      { roleKey: "administrator", permissionKey: "contacts:read" },
      { roleKey: "sales", permissionKey: "customers:write" },
    ];

    const put = await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants })
      .expect(200);

    expect(put.body.source).toBe("custom");
    expect(put.body.grants).toHaveLength(grants.length);

    // Finance can no longer create customers.
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ name: "Denied Customer" })
      .expect(403);

    // Sales can now create customers.
    await request(app.getHttpServer())
      .post(`/organisations/${org.id}/customers`)
      .set("Authorization", `Bearer ${tokens.get("sales")}`)
      .send({ name: "Allowed Customer" })
      .expect(201);
  });

  it("PUT with empty grants resets the org to default matrix", async () => {
    const response = await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants: [] })
      .expect(200);
    expect(response.body.source).toBe("default");
  });

  it("PUT rejects unknown roleKey or permissionKey → 400", async () => {
    const token = tokens.get("owner")!;
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grants: [{ roleKey: "superuser", permissionKey: "customers:read" }] })
      .expect(400);
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grants: [{ roleKey: "owner", permissionKey: "invoices:delete" }] })
      .expect(400);
  });

  it("PUT from a non-member returns 404", async () => {
    const outsider = await signToken({
      sub: randomUUID(),
      email: "permissions.outsider@test.eva.local",
    });
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${outsider}`)
      .send({ grants: [] })
      .expect(404);
  });

  it("PUT is audit-logged", async () => {
    const before = await owner.auditLog.count({
      where: { organisationId: org.id, action: "permissions.updated" },
    });
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({
        grants: PERMISSION_KEYS.map((permissionKey) => ({ roleKey: "owner", permissionKey })),
      })
      .expect(200);
    const after = await owner.auditLog.count({
      where: { organisationId: org.id, action: "permissions.updated" },
    });
    expect(after).toBe(before + 1);
  });

  it("PUT deduplicates duplicate grants", async () => {
    const grants = [
      { roleKey: "owner", permissionKey: "customers:read" },
      { roleKey: "owner", permissionKey: "customers:read" },
    ];
    const response = await request(app.getHttpServer())
      .put(`/organisations/${org.id}/permissions`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ grants })
      .expect(200);
    expect(response.body.grants).toHaveLength(1);
  });
});
