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
 * Tenant isolation at the API layer (BRD 9.4/15; Slice 0.3): org B's users
 * must never see or touch org A's data. Cross-tenant access is a 404 — the
 * API must not leak whether the other tenant exists.
 */
describe("Tenant isolation", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let orgA: FixtureOrg;
  let orgB: FixtureOrg;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    orgA = await createOrgWithMembers(owner, "isolation-a", ["owner", "finance"], "Tenant A Ltd");
    orgB = await createOrgWithMembers(owner, "isolation-b", ["owner"], "Tenant B Ltd");
    app = await createTestApp();
    tokenA = await signToken({
      sub: orgA.members[0]!.authUserId,
      email: orgA.members[0]!.email,
    });
    tokenB = await signToken({
      sub: orgB.members[0]!.authUserId,
      email: orgB.members[0]!.email,
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("B's organisation list contains only B's orgs", async () => {
    const response = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    const ids = response.body.map((o: { id: string }) => o.id);
    expect(ids).toContain(orgB.id);
    expect(ids).not.toContain(orgA.id);
  });

  it("B cannot list A's members (404, existence not leaked)", async () => {
    await request(app.getHttpServer())
      .get(`/organisations/${orgA.id}/members`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(404);
  });

  it("B cannot change roles inside A (404)", async () => {
    await request(app.getHttpServer())
      .patch(`/organisations/${orgA.id}/members/${orgA.members[1]!.id}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ roleKey: "read_only" })
      .expect(404);
  });

  it("A cannot list B's members either (symmetric)", async () => {
    await request(app.getHttpServer())
      .get(`/organisations/${orgB.id}/members`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(404);
  });

  it("an org B creates never appears in A's responses", async () => {
    const created = await request(app.getHttpServer())
      .post("/organisations")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ name: "Tenant B Second Org Ltd" })
      .expect(201);

    const listA = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    const idsA = listA.body.map((o: { id: string }) => o.id);
    expect(idsA).not.toContain(created.body.id);

    await request(app.getHttpServer())
      .get(`/organisations/${created.body.id}/members`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(404);
  });

  it("B's member list never contains A's users", async () => {
    const response = await request(app.getHttpServer())
      .get(`/organisations/${orgB.id}/members`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    const emails = response.body.map((m: { email: string }) => m.email);
    for (const member of orgA.members) {
      expect(emails).not.toContain(member.email);
    }
  });
});
