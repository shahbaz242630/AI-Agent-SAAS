import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOAuthState } from "../src/modules/mailboxes/oauth-state.js";
import type { EvaPrismaClient } from "@eva/database";
import { PERMISSION_KEYS, PERMISSION_MODULE, MODULE_KEYS, type ModuleKey } from "@eva/types";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  TEST_OAUTH_STATE_SECRET,
  type FixtureOrg,
} from "./support.js";

/**
 * Module entitlements (Slice 1.6a) — enforcement at the single choke point.
 *
 * The three gates and their ORDER are the subject: 404 for a non-member, 403
 * for a member whose role lacks the permission, 402 for an organisation that
 * has not bought the product. Order is an information-disclosure decision, not
 * an implementation detail, so it is asserted rather than assumed.
 */

/**
 * Routes that exercise each non-core module, so 402 is proven on real
 * endpoints and not just against the helper in isolation.
 *
 * `customers` is deliberately absent: it is CORE, and asserting 402 on it was
 * this spec's own first mistake. Which URL a route lives under says nothing —
 * the permission key it checks is what decides.
 */
const EMAIL_MODULE_ROUTES = [
  { name: "imports", path: (org: string) => `/organisations/${org}/imports` },
  { name: "reminder sequence", path: (org: string) => `/organisations/${org}/reminder-sequence` },
  { name: "mailbox", path: (org: string) => `/organisations/${org}/mailboxes` },
];

describe("Module entitlements (Slice 1.6a)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  /** Holds the email credit controller — the normal case. */
  let entitled: FixtureOrg;
  /** Deliberately holds NOTHING. */
  let bare: FixtureOrg;
  let stranger: FixtureOrg;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    entitled = await createOrgWithMembers(owner, "ent-yes", ["owner", "sales"]);
    bare = await createOrgWithMembers(owner, "ent-no", ["owner", "sales"], "Bare Org Ltd", []);
    stranger = await createOrgWithMembers(owner, "ent-other", ["owner"]);
    app = await createTestApp();
    for (const org of [entitled, bare, stranger]) {
      for (const member of org.members) {
        tokens.set(
          `${org.id}:${member.roleKey}`,
          await signToken({ sub: member.authUserId, email: member.email }),
        );
      }
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const tokenFor = (org: FixtureOrg, roleKey: string) => tokens.get(`${org.id}:${roleKey}`)!;

  /**
   * The exhaustiveness guarantee is a compile-time one (`Record<PermissionKey,
   * …>`), which is exactly why it deserves a runtime echo: a build error is
   * easy to silence with a cast, and an unmapped key would escape enforcement
   * silently and forever.
   */
  it("every permission key is assigned to a module or to core", () => {
    for (const key of PERMISSION_KEYS) {
      expect(PERMISSION_MODULE[key], `${key} has no module`).toBeDefined();
    }
    const owners = new Set(Object.values(PERMISSION_MODULE));
    for (const value of owners) {
      if (value !== "core") expect(MODULE_KEYS).toContain(value as ModuleKey);
    }
  });

  describe("402 when the organisation has not got the product", () => {
    it.each(EMAIL_MODULE_ROUTES)(
      "$name returns 402 with a machine-readable code",
      async ({ path }) => {
        const response = await request(app.getHttpServer())
          .get(path(bare.id))
          .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
          .expect(402);

        // The code is what the web app branches on to show an upgrade prompt
        // rather than a dead end. Prose is not an API.
        expect(response.body.code).toBe("module_not_entitled");
        expect(response.body.module).toBe("email_credit_controller");
        expect(response.body.statusCode).toBe(402);
        expect(response.body.message).toBeTruthy();
      },
    );

    it.each(EMAIL_MODULE_ROUTES)("$name works for an entitled organisation", async ({ path }) => {
      await request(app.getHttpServer())
        .get(path(entitled.id))
        .set("Authorization", `Bearer ${tokenFor(entitled, "owner")}`)
        .expect(200);
    });

    it("a DISABLED module is refused exactly like a missing one", async () => {
      const module = await owner.organisationModule.findFirstOrThrow({
        where: { organisationId: entitled.id, moduleKey: "email_credit_controller" },
      });
      await owner.organisationModule.update({ where: { id: module.id }, data: { enabled: false } });
      try {
        await request(app.getHttpServer())
          .get(`/organisations/${entitled.id}/mailboxes`)
          .set("Authorization", `Bearer ${tokenFor(entitled, "owner")}`)
          .expect(402);
      } finally {
        await owner.organisationModule.update({
          where: { id: module.id },
          data: { enabled: true },
        });
      }
    });

    it("a SOFT-DELETED module row is refused too — fail closed", async () => {
      const module = await owner.organisationModule.findFirstOrThrow({
        where: { organisationId: entitled.id, moduleKey: "email_credit_controller" },
      });
      await owner.organisationModule.update({
        where: { id: module.id },
        data: { deletedAt: new Date() },
      });
      try {
        await request(app.getHttpServer())
          .get(`/organisations/${entitled.id}/mailboxes`)
          .set("Authorization", `Bearer ${tokenFor(entitled, "owner")}`)
          .expect(402);
      } finally {
        await owner.organisationModule.update({
          where: { id: module.id },
          data: { deletedAt: null },
        });
      }
    });
  });

  /**
   * THE LOCKOUT TRAP. Gate everything and an organisation with no products
   * cannot reach the screen that sells it one — the customer is stuck forever,
   * and the failure is invisible until someone actually has an empty account.
   */
  describe("the lockout trap: core still works with zero modules", () => {
    it.each([
      ["customers", (org: string) => `/organisations/${org}/customers`],
      ["permissions", (org: string) => `/organisations/${org}/permissions`],
      ["members", (org: string) => `/organisations/${org}/members`],
    ])("%s is reachable by an organisation holding nothing", async (name, path) => {
      const response = await request(app.getHttpServer())
        .get(path(bare.id))
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`);
      expect(response.status, `${name} must not be gated behind a purchase`).toBe(200);
    });

    it("an organisation with nothing can still list its modules and buy one", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/modules`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(200);
    });
  });

  /**
   * Ordering. Each of these would still "work" if the checks ran in a
   * different order — they would just leak. A stranger learning that an
   * organisation has NOT bought a product tells them the organisation exists.
   */
  describe("gate ordering is an information-disclosure decision", () => {
    it("404 beats 402: a non-member never learns what an org has bought", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor(stranger, "owner")}`)
        .expect(404);
    });

    it("404 beats 402 even when the org IS entitled", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${entitled.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor(stranger, "owner")}`)
        .expect(404);
    });

    it("403 beats 402: a member without the permission learns nothing either", async () => {
      // sales holds no mailbox:read, and this org holds no module — 403 wins,
      // so the subscription state stays invisible to a junior member.
      await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor(bare, "sales")}`)
        .expect(403);
    });
  });

  /**
   * The known trap, recorded in the plan before it bit: the @Public() OAuth
   * callback calls requirePermission internally, so it inherits the 402 — and
   * its contract is ALWAYS a redirect, never JSON.
   */
  it("the public OAuth callback turns an inherited 402 into a redirect, not an exception", async () => {
    const ownerMember = bare.members.find((member) => member.roleKey === "owner")!;
    const state = await signOAuthState(TEST_OAUTH_STATE_SECRET, {
      organisationId: bare.id,
      userId: ownerMember.id,
      nonce: randomUUID(),
    });

    const response = await request(app.getHttpServer())
      .get(`/integrations/microsoft/callback?code=fake&state=${state}`)
      .expect(302);

    // Its own code, not `connect_failed`: telling someone whose organisation
    // has no Invoice Chasing to "try again" is advice that can never work.
    expect(response.headers.location).toContain("error=module_not_entitled");
  });

  describe("PUT .../modules/:moduleKey", () => {
    const put = (org: FixtureOrg, moduleKey: string, role = "owner") =>
      request(app.getHttpServer())
        .put(`/organisations/${org.id}/modules/${moduleKey}`)
        .set("Authorization", `Bearer ${tokenFor(org, role)}`);

    it("turning a product on makes its routes work immediately", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/imports`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(402);

      await put(bare, "email_credit_controller").send({ enabled: true }).expect(200);

      await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/imports`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(200);

      // Put it back: later specs in this file rely on `bare` holding nothing.
      await put(bare, "email_credit_controller").send({ enabled: false }).expect(200);
      await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/imports`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(402);
    });

    it("audits both directions in the same transaction as the change", async () => {
      await put(bare, "email_credit_controller").send({ enabled: true }).expect(200);
      await put(bare, "email_credit_controller").send({ enabled: false }).expect(200);

      const actions = await owner.auditLog.findMany({
        where: { organisationId: bare.id, action: { in: ["module.enabled", "module.disabled"] } },
        orderBy: { createdAt: "desc" },
        take: 2,
      });
      expect(actions.map((row) => row.action)).toContain("module.enabled");
      expect(actions.map((row) => row.action)).toContain("module.disabled");
    });

    /** Dependencies are validated on the WRITE. A stored invalid combination
     *  would otherwise have to be re-derived on every permission check. */
    it("refuses a product whose prerequisite is missing, and NAMES it", async () => {
      const response = await put(entitled, "lead_follow_up_agent")
        .send({ enabled: true })
        .expect(400);
      // The customer can only act on this if we say what to buy first.
      expect(response.body.message).toContain("voice_credit_controller");
    });

    it("accepts the same product once its prerequisite chain is enabled", async () => {
      await put(entitled, "voice_credit_controller").send({ enabled: true }).expect(200);
      const response = await put(entitled, "lead_follow_up_agent")
        .send({ enabled: true })
        .expect(200);
      const lead = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "lead_follow_up_agent",
      );
      expect(lead.enabled).toBe(true);
      expect(lead.missingDependencies).toEqual([]);
    });

    it("reports what a locked product is still waiting for", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/modules`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(200);

      expect(response.body).toHaveLength(4);
      const receptionist = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "ai_receptionist",
      );
      expect(receptionist.enabled).toBe(false);
      expect(receptionist.missingDependencies).toContain("voice_credit_controller");
    });

    it("rejects a product that does not exist rather than 500ing on the CHECK", async () => {
      await put(entitled, "crystal_ball").send({ enabled: true }).expect(400);
    });

    /** `modules:manage` is owner-only by default: enabling a product commits
     *  the business to money, and that is not a delegated administrator's
     *  call. Asserted because the default matrix otherwise gives an
     *  administrator every key. */
    it("is refused for a role without modules:manage", async () => {
      await put(entitled, "email_credit_controller", "sales").send({ enabled: true }).expect(403);
    });

    it("leaves seats alone when the body does not mention them", async () => {
      await put(entitled, "email_credit_controller").send({ enabled: true, seats: 3 }).expect(200);
      const response = await put(entitled, "email_credit_controller")
        .send({ enabled: true })
        .expect(200);
      const email = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "email_credit_controller",
      );
      // An enable must never silently reset a seat count somebody paid for.
      expect(email.seats).toBe(3);
    });
  });
});
