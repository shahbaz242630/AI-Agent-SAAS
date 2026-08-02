import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORGANISATION_ROLES, type OrganisationRole } from "@eva/types";
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
 * Role × endpoint authorisation matrix (BRD 7; Slice 0.3). Every BRD role is
 * exercised against both member endpoints. Listing members requires
 * membership; changing roles requires owner/administrator.
 */
const CAN_CHANGE_ROLE: ReadonlySet<OrganisationRole> = new Set(["owner", "administrator"]);

describe("Authorisation matrix: role × endpoint", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  /** Dedicated target member whose role gets flipped by the matrix. */
  let targetUserId: string;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    org = await createOrgWithMembers(owner, "matrix", [...ORGANISATION_ROLES, "read_only"]);
    // The second read_only member is the role-change target.
    targetUserId = org.members[org.members.length - 1]!.id;
    app = await createTestApp();
    for (const member of org.members.slice(0, ORGANISATION_ROLES.length)) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it.each(ORGANISATION_ROLES.map((roleKey) => ({ roleKey })))(
    "GET members as $roleKey → 200 (any member may list)",
    async ({ roleKey }) => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/members`)
        .set("Authorization", `Bearer ${tokens.get(roleKey)}`)
        .expect(200);
      expect(response.body.length).toBe(org.members.length);
    },
  );

  it.each(
    ORGANISATION_ROLES.map((roleKey, index) => ({
      roleKey,
      expected: CAN_CHANGE_ROLE.has(roleKey) ? 200 : 403,
      // Alternate the target's role so each allowed change is a real write.
      newRole: index % 2 === 0 ? "sales" : "read_only",
    })),
  )("PATCH member role as $roleKey → $expected", async ({ roleKey, expected, newRole }) => {
    await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/members/${targetUserId}`)
      .set("Authorization", `Bearer ${tokens.get(roleKey)}`)
      .send({ roleKey: newRole })
      .expect(expected);
  });

  it("rejects an unknown roleKey with 400 (role must exist)", async () => {
    await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/members/${targetUserId}`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ roleKey: "superuser" })
      .expect(400);
  });

  it("returns 404 when the target user is not a member", async () => {
    await request(app.getHttpServer())
      .patch(`/organisations/${org.id}/members/${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .send({ roleKey: "sales" })
      .expect(404);
  });

  it("rejects a non-uuid organisation id with 400", async () => {
    await request(app.getHttpServer())
      .get("/organisations/not-a-uuid/members")
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(400);
  });
});

/**
 * The last owner may not be demoted (2026-08-02).
 *
 * An organisation with zero owners is UNRECOVERABLE from inside the product:
 * only owners and administrators may change roles, and `modules:manage` is
 * owner-only (slice 1.6a), so it can neither promote anyone back nor turn its
 * own products on again.
 *
 * Its own organisation, deliberately — these specs change who owns what, and
 * the matrix fixture above would be left in a shape its own specs do not expect.
 */
describe("the last owner cannot be demoted", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let ownerToken: string;
  let ownerUserId: string;
  let adminUserId: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    org = await createOrgWithMembers(owner, "lastowner", ["owner", "administrator"]);
    const ownerMember = org.members.find((member) => member.roleKey === "owner")!;
    ownerUserId = ownerMember.id;
    adminUserId = org.members.find((member) => member.roleKey === "administrator")!.id;
    app = await createTestApp();
    ownerToken = await signToken({ sub: ownerMember.authUserId, email: ownerMember.email });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const patch = (userId: string, roleKey: string) =>
    request(app.getHttpServer())
      .patch(`/organisations/${org.id}/members/${userId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ roleKey });

  it("refuses, and the message says what to do instead", async () => {
    const response = await patch(ownerUserId, "sales").expect(400);
    // Naming the way out matters: "forbidden" would leave them stuck.
    expect(response.body.message).toMatch(/only owner/i);
    expect(response.body.message).toMatch(/someone else an owner/i);
  });

  it("leaves the role untouched when it refuses", async () => {
    const membership = await owner.organisationMembership.findFirst({
      where: { organisationId: org.id, userId: ownerUserId },
      include: { role: true },
    });
    expect(membership?.role.key).toBe("owner");
  });

  it("audits a role change with both the old and the new role", async () => {
    await patch(adminUserId, "sales").expect(200);
    const row = await owner.auditLog.findFirst({
      where: { organisationId: org.id, action: "member.role_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row?.metadata).toMatchObject({
      targetUserId: adminUserId,
      fromRoleKey: "administrator",
      toRoleKey: "sales",
    });
  });

  it("allows the owner to step down once a second owner exists", async () => {
    await patch(adminUserId, "owner").expect(200);
    await patch(ownerUserId, "sales").expect(200);

    const owners = await owner.organisationMembership.count({
      where: { organisationId: org.id, role: { key: "owner" } },
    });
    expect(owners).toBe(1);
  });
});
