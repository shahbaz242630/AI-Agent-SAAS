import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { createOwnerClient, createTestApp, seedTestDatabase, signToken } from "./support.js";

/**
 * Organisations: create + list (Slice 0.3). Org creation MUST run inside a
 * withTenant context keyed to the new org id (RLS) and grant the caller the
 * owner role.
 */
describe("Organisations: create and list", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("returns an empty list for a user with no memberships", async () => {
    const token = await signToken({ sub: randomUUID(), email: "orgscreate.nobody@test.eva.local" });
    const response = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual([]);
  });

  it("creates an org with default settings and owner membership for the caller", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "orgscreate.founder@test.eva.local" });

    const created = await request(app.getHttpServer())
      .post("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Founder Org Ltd" })
      .expect(201);

    expect(created.body.id).toEqual(expect.any(String));
    expect(created.body.name).toBe("Founder Org Ltd");
    expect(created.body.roleKey).toBe("owner");

    // Default settings row exists (BRD 18.1 defaults).
    const settings = await owner.organisationSettings.findUniqueOrThrow({
      where: { organisationId: created.body.id },
    });
    expect(settings.timezone).toBe("Europe/London");
    expect(settings.locale).toBe("en-GB");

    // The new org shows up in the caller's list with the owner role.
    const list = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      id: created.body.id,
      name: "Founder Org Ltd",
      roleKey: "owner",
    });

    // And the caller is its only member.
    const members = await request(app.getHttpServer())
      .get(`/organisations/${created.body.id}/members`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(members.body).toHaveLength(1);
    expect(members.body[0]).toMatchObject({
      email: "orgscreate.founder@test.eva.local",
      roleKey: "owner",
    });
  });

  it("rejects an empty organisation name with 400", async () => {
    const token = await signToken({ sub: randomUUID(), email: "orgscreate.bad@test.eva.local" });
    await request(app.getHttpServer())
      .post("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "   " })
      .expect(400);
  });

  it("never trusts a client-supplied organisation id", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "orgscreate.sneaky@test.eva.local" });
    const attackerOrgId = randomUUID();
    const created = await request(app.getHttpServer())
      .post("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sneaky Org Ltd", id: attackerOrgId, organisationId: attackerOrgId })
      .expect(201);
    expect(created.body.id).not.toBe(attackerOrgId);
  });
});
