import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { DEFAULT_ROLE_PERMISSIONS, ORGANISATION_ROLES, PERMISSION_KEYS } from "@eva/types";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

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

  it("gives a brand-new organisation's owner their permissions in the create response", async () => {
    const token = await signToken({ sub: randomUUID(), email: "orgscreate.perms@test.eva.local" });
    const created = await request(app.getHttpServer())
      .post("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Permissions Org Ltd" })
      .expect(201);
    expect(created.body.permissions).toEqual([...PERMISSION_KEYS]);
  });
});

/**
 * What the caller may do here, published on their own organisation summary
 * (slice 1.6c, task 8).
 *
 * ⚠️ THE POINT OF THESE TESTS is that the web app must not work this out for
 * itself. It has `roleKey`, and `DEFAULT_ROLE_PERMISSIONS` is importable from
 * `@eva/types`, so consulting the matrix in the browser looks obviously correct
 * and is wrong for every organisation that has customised its mapping — which
 * this API has supported since slice 1.1. The override test below is the one
 * that fails if anybody replaces this with the matrix.
 */
describe("Organisations: the caller's own permissions", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  const tokens = new Map<string, string>();

  const listAs = (roleKey: string) =>
    request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${tokens.get(roleKey)}`);

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "orgperms", [...ORGANISATION_ROLES]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("reports each of the six roles' default permissions, and only the caller's own", async () => {
    for (const roleKey of ORGANISATION_ROLES) {
      const response = await listAs(roleKey).expect(200);
      const mine = response.body.find((row: { id: string }) => row.id === org.id);
      expect(mine, `${roleKey} should see its own organisation`).toBeDefined();
      expect([...mine.permissions].sort(), `permissions for ${roleKey}`).toEqual(
        [...DEFAULT_ROLE_PERMISSIONS[roleKey]].sort(),
      );
    }
  });

  it("gives the three read-only roles invoices:read and never invoices:write", async () => {
    // Named explicitly rather than left to the matrix comparison above, because
    // this is the exact pair every invoice screen branches on, and the 1.6b
    // regression that made /app/clients 403 for three of six roles was a
    // wrong belief about precisely these three.
    for (const roleKey of ["sales", "reception", "read_only"]) {
      const response = await listAs(roleKey).expect(200);
      const mine = response.body.find((row: { id: string }) => row.id === org.id);
      expect(mine.permissions, roleKey).toContain("invoices:read");
      expect(mine.permissions, roleKey).not.toContain("invoices:write");
      // The import screens branch on these two the same way.
      expect(mine.permissions, roleKey).toContain("imports:read");
      expect(mine.permissions, roleKey).not.toContain("imports:write");
    }
  });

  it("gives owner, administrator and finance invoices:write", async () => {
    for (const roleKey of ["owner", "administrator", "finance"]) {
      const response = await listAs(roleKey).expect(200);
      const mine = response.body.find((row: { id: string }) => row.id === org.id);
      expect(mine.permissions, roleKey).toContain("invoices:write");
      expect(mine.permissions, roleKey).toContain("imports:write");
    }
  });

  it("is NOT the entitlement answer: an un-entitled org still reports invoices:write", async () => {
    /**
     * ⚠️ THIS TEST EXISTS TO STOP A HELPFUL SIMPLIFICATION. Folding "does the
     * org hold the product" into this list would make one field answer two
     * questions, and a screen would then say "ask an owner or administrator"
     * to a customer whose actual problem is that they have not bought Invoice
     * Chasing — the wrong advice, given confidently. Standing rule §0d: when
     * two causes are distinguishable, never name the wrong one.
     *
     * The 402 is still enforced; it is just enforced where it belongs, on the
     * request. Both halves are asserted here so the pair cannot drift.
     */
    const bare = await createOrgWithMembers(owner, "orgperms-bare", ["owner"], undefined, []);
    const member = bare.members[0]!;
    const token = await signToken({ sub: member.authUserId, email: member.email });

    const response = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const mine = response.body.find((row: { id: string }) => row.id === bare.id);
    expect(mine.permissions).toContain("invoices:write");

    // And the request itself is still refused, with the code that names the
    // real cause.
    const refused = await request(app.getHttpServer())
      .get(`/organisations/${bare.id}/invoices`)
      .set("Authorization", `Bearer ${token}`)
      .expect(402);
    expect(refused.body.code).toBe("module_not_entitled");
  });

  it("follows a CUSTOM org mapping, which the BRD default matrix would get wrong", async () => {
    /**
     * The case that decides where this list is computed. `sales` gains
     * `invoices:write` and `finance` loses it — so an organisation's own
     * mapping now DISAGREES with `DEFAULT_ROLE_PERMISSIONS` in both directions.
     * A browser consulting the matrix would hide the button from the person who
     * may use it and offer it to the person who may not.
     */
    const custom = await createOrgWithMembers(owner, "orgperms-custom", [
      "owner",
      "finance",
      "sales",
    ]);
    const tokenFor = new Map<string, string>();
    for (const member of custom.members) {
      tokenFor.set(
        member.roleKey,
        await signToken({ sub: member.authUserId, email: member.email }),
      );
    }

    const current = await request(app.getHttpServer())
      .get(`/organisations/${custom.id}/permissions`)
      .set("Authorization", `Bearer ${tokenFor.get("owner")}`)
      .expect(200);
    expect(current.body.source).toBe("default");

    const grants = current.body.grants.filter(
      (grant: { roleKey: string; permissionKey: string }) =>
        !(grant.roleKey === "finance" && grant.permissionKey === "invoices:write"),
    );
    grants.push({ roleKey: "sales", permissionKey: "invoices:write" });

    await request(app.getHttpServer())
      .put(`/organisations/${custom.id}/permissions`)
      .set("Authorization", `Bearer ${tokenFor.get("owner")}`)
      .send({ grants })
      .expect(200);

    const asSales = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${tokenFor.get("sales")}`)
      .expect(200);
    const salesRow = asSales.body.find((row: { id: string }) => row.id === custom.id);
    expect(salesRow.permissions).toContain("invoices:write");
    expect(DEFAULT_ROLE_PERMISSIONS.sales).not.toContain("invoices:write");

    const asFinance = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${tokenFor.get("finance")}`)
      .expect(200);
    const financeRow = asFinance.body.find((row: { id: string }) => row.id === custom.id);
    expect(financeRow.permissions).not.toContain("invoices:write");
    expect(DEFAULT_ROLE_PERMISSIONS.finance).toContain("invoices:write");

    // And the published list agrees with what the request actually does — the
    // whole reason the screen is allowed to trust it.
    await request(app.getHttpServer())
      .post(`/organisations/${custom.id}/customers`)
      .set("Authorization", `Bearer ${tokenFor.get("owner")}`)
      .send({ name: "Custom Mapping Client" })
      .expect(201);
  });

  it("never reports a permission key this build does not have", async () => {
    /**
     * A row naming a removed or hand-written permission must not travel into a
     * typed list the rest of the app trusts. Written straight to the table
     * because the API's own PUT validates the key — which is the point: this
     * covers the row that got in some other way.
     */
    const stray = await createOrgWithMembers(owner, "orgperms-stray", ["owner"]);
    const member = stray.members[0]!;
    const role = await owner.role.findUniqueOrThrow({ where: { key: "owner" } });
    await owner.organisationRolePermission.create({
      data: {
        organisationId: stray.id,
        roleId: role.id,
        permissionKey: "invoices:read",
      },
    });
    await owner.organisationRolePermission.create({
      data: {
        organisationId: stray.id,
        roleId: role.id,
        permissionKey: "invoices:teleport",
      },
    });

    const token = await signToken({ sub: member.authUserId, email: member.email });
    const response = await request(app.getHttpServer())
      .get("/organisations")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const mine = response.body.find((row: { id: string }) => row.id === stray.id);
    expect(mine.permissions).toEqual(["invoices:read"]);
  });
});
