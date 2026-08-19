import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOAuthState } from "../src/capabilities/mailbox/oauth-state.js";
import type { EvaPrismaClient } from "@eva/database";
import {
  PERMISSION_KEYS,
  PERMISSION_MODULES,
  MODULE_CAPABILITIES,
  MODULE_DEPENDENCIES,
  MODULE_KEYS,
  CAPABILITIES,
} from "@eva/types";
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
    entitled = await createOrgWithMembers(owner, "ent-yes", ["owner", "sales", "finance"]);
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
      const requirement = PERMISSION_MODULES[key];
      expect(requirement, `${key} has no module`).toBeDefined();
      if (requirement === "core") continue;
      /**
       * ⚠️ AN EMPTY LIST WOULD MEAN "NOBODY MAY EVER DO THIS" and would read
       * as a mapping rather than a lockout. The tuple type refuses it at
       * compile time; this is the runtime echo, for the same reason the
       * exhaustiveness check has one — a build error is easy to silence with a
       * cast, and this failure is silent and permanent.
       */
      expect(requirement.length, `${key} is satisfied by no product`).toBeGreaterThan(0);
      for (const moduleKey of requirement) expect(MODULE_KEYS).toContain(moduleKey);
    }
  });

  /**
   * ⚠️ THE DEFECT THIS SLICE EXISTS FOR (founder, 2026-08-19).
   *
   * `MODULE_DEPENDENCIES` used to read `lead_follow_up_agent:
   * ["voice_credit_controller"]` and `voice_credit_controller:
   * ["email_credit_controller"]`, and `assertDependenciesMet` refuses to enable
   * a product whose dependencies are not already on. That made **three of the
   * six packages in the BRD's own price list unsellable** — "Lead Assistant"
   * (lead follow-up alone), "AI Receptionist" (receptionist alone) and "Sales
   * Desk" (the two together) — while BRD §4.3 says in as many words that the
   * lead agent "does not require the Voice Credit Controller module".
   *
   * The price list and the rule lived in different files with nothing between
   * them. This is the thing between them.
   */
  it("no product requires another — they are separate purchases", () => {
    for (const moduleKey of MODULE_KEYS) {
      expect(
        MODULE_DEPENDENCIES[moduleKey],
        `${moduleKey} forces a customer to buy something else`,
      ).toEqual([]);
    }
  });

  /**
   * The rule survives its own emptying. `MODULE_DEPENDENCIES` stays as the one
   * place a genuine product-to-product prerequisite would go, so this asserts
   * the SHAPE rather than today's contents — a typo in a key added later would
   * otherwise refuse a product forever, naming a prerequisite nobody can buy.
   */
  it("any prerequisite ever added must name a real product", () => {
    for (const moduleKey of MODULE_KEYS) {
      for (const dependency of MODULE_DEPENDENCIES[moduleKey]) {
        expect(MODULE_KEYS).toContain(dependency);
        expect(dependency, `${moduleKey} depends on itself`).not.toBe(moduleKey);
      }
    }
  });

  it("every product's machinery is real, and every product needs some", () => {
    for (const moduleKey of MODULE_KEYS) {
      const needed = MODULE_CAPABILITIES[moduleKey];
      expect(needed.length, `${moduleKey} needs no machinery at all`).toBeGreaterThan(0);
      for (const capability of needed) expect(CAPABILITIES).toContain(capability);
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
        expect(response.body.modules).toContain("email_credit_controller");
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

    /**
     * Reading the product list and changing it are separate permissions, and
     * deliberately land in different places in the default matrix. Seeing what
     * your organisation holds is what makes a 402 elsewhere legible rather than
     * looking like a fault; committing the business to money is the owner's.
     */
    it("a role with modules:read but not modules:manage can look but not touch", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${entitled.id}/modules`)
        .set("Authorization", `Bearer ${tokenFor(entitled, "finance")}`)
        .expect(200);

      await request(app.getHttpServer())
        .put(`/organisations/${entitled.id}/modules/email_credit_controller`)
        .set("Authorization", `Bearer ${tokenFor(entitled, "finance")}`)
        .send({ enabled: false })
        .expect(403);
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

    /**
     * A seat is money, so the audit trail has to say which thing happened.
     * Buying a seat on an already-on product used to record `module.enabled`,
     * which reads as "they turned it on" — found by using the product on
     * staging, 2026-08-02, with the whole gate green.
     */
    it("audits a seats-only change as a seats change, not as an enable", async () => {
      await put(entitled, "email_credit_controller").send({ enabled: true, seats: 2 }).expect(200);
      await put(entitled, "email_credit_controller").send({ enabled: true, seats: 3 }).expect(200);

      const row = await owner.auditLog.findFirst({
        where: { organisationId: entitled.id, entityType: "organisation_module" },
        orderBy: { createdAt: "desc" },
      });
      expect(row?.action).toBe("module.seats_changed");
      expect(row?.metadata).toMatchObject({ seats: 3, previousSeats: 2 });

      // Restore the baseline the later specs in this file expect.
      await put(entitled, "email_credit_controller").send({ enabled: true, seats: 1 }).expect(200);
    });

    /**
     * ⚠️ THIS TEST USED TO ASSERT THE DEFECT. It sent the same request and
     * expected the message to contain "voice_credit_controller" — proving that
     * buying the lead agent required buying voice credit control first, which
     * is exactly what made "Lead Assistant" unsellable.
     *
     * The refusal must still happen, because the lead agent is not built yet.
     * What changed is the REASON, and the reason is the whole point: "we have
     * not finished it" is a wait, "buy two other products first" is a wall.
     */
    it("refuses lead follow-up for being unbuilt, NOT for a prerequisite", async () => {
      const response = await put(entitled, "lead_follow_up_email")
        .send({ enabled: true })
        .expect(400);
      expect(response.body.message).toContain("isn't built yet");
      expect(response.body.message).not.toContain("voice_credit_controller");
      expect(response.body.message).not.toContain("Voice Credit Control");
    });

    /**
     * The other half of the same ruling, on an organisation that holds NOTHING.
     * A bare org enabling the one built product must not be told to buy
     * anything first — that is the "Email Credit Controller only" package, and
     * it is the shape every other package now follows.
     */
    it("sells the built product to an organisation that holds nothing", async () => {
      const response = await put(bare, "email_credit_controller")
        .send({ enabled: true })
        .expect(200);
      const invoiceFollowUp = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "email_credit_controller",
      );
      expect(invoiceFollowUp.enabled).toBe(true);
      expect(invoiceFollowUp.missingDependencies).toEqual([]);

      // Restore the baseline the rest of this file expects of `bare`.
      await put(bare, "email_credit_controller").send({ enabled: false }).expect(200);
    });

    /**
     * ⚠️ THIS TEST USED TO ASSERT THE DEFECT (found by walking, 2026-08-18).
     *
     * It enabled Voice Credit Control, then Lead Follow-up, and checked both
     * came back `enabled: true` — which they did, and which was exactly the
     * bug. Four of the five products are not built: they own no permissions in
     * `PERMISSION_MODULE`, so turning one on wrote a row, printed "On" and
     * delivered nothing. The screen no longer offers the button, but the button
     * was never what stopped it — this is.
     *
     * `voice_credit_controller` has its prerequisite met here (`entitled` holds
     * the email controller), so the only thing left to refuse it is being
     * unbuilt.
     */
    it("refuses a product that is not built yet, even with its prerequisites met", async () => {
      const response = await put(entitled, "voice_credit_controller")
        .send({ enabled: true })
        .expect(400);
      // Named as a customer would read it, not as the database spells it.
      expect(response.body.message).toContain("Voice Credit Control");
      expect(response.body.message).toContain("isn't built yet");

      const modules = await request(app.getHttpServer())
        .get(`/organisations/${entitled.id}/modules`)
        .set("Authorization", `Bearer ${tokenFor(entitled, "owner")}`)
        .expect(200);
      const voice = modules.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "voice_credit_controller",
      );
      // The refusal has to leave nothing behind — a half-written entitlement
      // would be the same lie in the database instead of on the screen.
      expect(voice.enabled).toBe(false);
    });

    /**
     * ⚠️ TURNING ONE OFF MUST STILL WORK. If an unbuilt product is somehow
     * already on — an older row, a seeded environment, a hand-edited database —
     * a guard that refused every write would trap the organisation in the very
     * state it exists to prevent.
     */
    it("still lets an unbuilt product be turned OFF", async () => {
      await owner.organisationModule.create({
        data: {
          organisationId: entitled.id,
          moduleKey: "voice_credit_controller",
          enabled: true,
          seats: 1,
          source: "manual",
        },
      });

      const response = await put(entitled, "voice_credit_controller")
        .send({ enabled: false })
        .expect(200);
      const voice = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "voice_credit_controller",
      );
      expect(voice.enabled).toBe(false);
    });

    /**
     * ⚠️ WHAT A PRODUCT IS WAITING FOR IS MACHINERY, NOT A PURCHASE.
     *
     * This asserted `missingDependencies` contained "voice_credit_controller" —
     * i.e. "buy another product first". The receptionist is waiting for the
     * voice stack, which we have not built; that is ours to finish, not the
     * customer's to buy, and the two must never read the same on a screen.
     */
    it("reports MACHINERY a product is waiting for, and demands no purchase", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/modules`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(200);

      // Derived, never a literal: this said `4` and broke the day lead
      // follow-up became two products (2026-08-19). A hardcoded count is one
      // more copy of the catalogue that has to be remembered.
      expect(response.body).toHaveLength(MODULE_KEYS.length);
      const receptionist = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "ai_receptionist",
      );
      expect(receptionist.enabled).toBe(false);
      expect(receptionist.missingDependencies).toEqual([]);
      expect(receptionist.missingCapabilities).toContain("voice");

      /**
       * The lead agent on a mailbox-less org is the case that matters
       * commercially: it is missing the mailbox, and that is a thing to SAY,
       * never a reason to refuse the sale.
       */
      const leadAgent = response.body.find(
        (row: { moduleKey: string }) => row.moduleKey === "lead_follow_up_email",
      );
      expect(leadAgent.missingDependencies).toEqual([]);
      expect(leadAgent.missingCapabilities).toContain("mailbox");
    });

    /**
     * ⚠️ THE MAILBOX IS SHARED MACHINERY, AND THIS IS THE PROOF.
     *
     * `mailbox:read` belonged to `email_credit_controller` alone until
     * 2026-08-19, so an organisation holding ONLY the lead agent could not
     * reach its own mailbox — the single thing that product needs. The row is
     * seeded directly because the lead agent is not built yet and the API
     * rightly refuses to enable it; the permission rule under test is
     * independent of that.
     */
    it("lets an organisation holding ONLY lead follow-up by email reach the mailbox", async () => {
      const leadOnly = await createOrgWithMembers(
        owner,
        "ent-lead-only",
        ["owner"],
        "Lead Only Ltd",
        [],
      );
      const member = leadOnly.members[0]!;
      const token = await signToken({ sub: member.authUserId, email: member.email });
      await owner.organisationModule.create({
        data: {
          organisationId: leadOnly.id,
          moduleKey: "lead_follow_up_email",
          enabled: true,
          seats: 1,
          source: "manual",
        },
      });

      await request(app.getHttpServer())
        .get(`/organisations/${leadOnly.id}/mailboxes`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      // ...and the invoice routes stay refused, because holding one product
      // must not quietly hand over another's.
      await request(app.getHttpServer())
        .get(`/organisations/${leadOnly.id}/imports`)
        .set("Authorization", `Bearer ${token}`)
        .expect(402);
    });

    /** A 402 names every product that would unlock the route, because holding
     *  ANY ONE of them is enough and naming one would misdirect the purchase. */
    it("names both products when the mailbox is refused", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${bare.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor(bare, "owner")}`)
        .expect(402);

      expect(response.body.modules).toEqual(["email_credit_controller", "lead_follow_up_email"]);
      expect(response.body.message).toContain(" or ");
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
