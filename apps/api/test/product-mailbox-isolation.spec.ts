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
 * The two products share NOTHING — founder ruling 2026-09-01:
 * *"they should have full complete seperate setups.. nothing combined/shared ..
 *  if later one is switched off the other one is not impacted and keeps
 *  working"*.
 *
 * ⚠️ THE FIRST TEST HERE IS A REGRESSION TEST FOR A DEFECT THAT WAS LIVE, NOT A
 * GUARD AGAINST A HYPOTHETICAL. Until slice 3.1c-0, readiness asked
 * `emailAccount.count({ deletedAt: null }) > 0` for the whole ORGANISATION and
 * gave that one answer to every product. Connecting Outlook for Invoice Chasing
 * therefore made Lead Follow-up report itself set up, on screen, with a mailbox
 * it had never been given — and the first reply would have left an account the
 * customer chose for something else.
 *
 * ⚠️ IT IS WRITTEN AGAINST THE HTTP SURFACE ON PURPOSE. Every crossing this
 * slice removed was invisible in the types and perfectly valid TypeScript; what
 * makes them findable is asking the API the question a customer's screen asks
 * and reading the answer.
 */
describe("Two products, two mailboxes, no crossing", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let token: string;

  /** A live mailbox for one product, written directly — the OAuth round trip is
   *  `mailboxes.spec.ts`'s subject, and repeating it here would only add ways
   *  for this file to fail for reasons that are not its own. */
  async function connect(moduleKey: string, address: string, isPrimary = true) {
    return owner.emailAccount.create({
      data: {
        organisationId: org.id,
        moduleKey,
        provider: "microsoft",
        emailAddress: address,
        healthStatus: "active",
        isPrimary,
      },
    });
  }

  async function modules() {
    const response = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/modules`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const rows = (response.body.modules ?? response.body) as {
      moduleKey: string;
      seatsUsed: number | null;
      missingCapabilities: string[];
    }[];
    return new Map(rows.map((row) => [row.moduleKey, row]));
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    // The customer bought BOTH products. That is the whole point: everything
    // below is about two products that legitimately coexist.
    org = await createOrgWithMembers(owner, "isolation", ["owner"], "Isolation Ltd", [
      { moduleKey: "email_credit_controller" },
      { moduleKey: "lead_follow_up_email" },
    ]);
    const member = org.members[0]!;
    token = await signToken({ sub: member.authUserId, email: member.email });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /**
   * ⚠️ THIS IS THE ONE THAT WOULD HAVE GONE RED BEFORE THE SLICE. Everything
   * else here defends a rule; this one describes a bug a customer could have
   * met on production.
   */
  it("one product's mailbox does not make the other look ready", async () => {
    await connect("email_credit_controller", "chasing@isolation.invalid");

    const byKey = await modules();
    expect(byKey.get("email_credit_controller")!.missingCapabilities).not.toContain("mailbox");
    // The claim the old code got wrong: Lead Follow-up has been given nothing.
    expect(byKey.get("lead_follow_up_email")!.missingCapabilities).toContain("mailbox");
  });

  it("counts each product's seats separately", async () => {
    const byKey = await modules();
    expect(byKey.get("email_credit_controller")!.seatsUsed).toBe(1);
    // Not null and not 1 — this product reports its OWN count, and it is zero.
    expect(byKey.get("lead_follow_up_email")!.seatsUsed).toBe(0);
  });

  it("lists only the mailboxes belonging to the product asked for", async () => {
    await connect("lead_follow_up_email", "leads@isolation.invalid");

    const chasing = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/mailboxes?module=email_credit_controller`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const leads = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/mailboxes?module=lead_follow_up_email`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(chasing.body.mailboxes.map((m: { emailAddress: string }) => m.emailAddress)).toEqual([
      "chasing@isolation.invalid",
    ]);
    expect(leads.body.mailboxes.map((m: { emailAddress: string }) => m.emailAddress)).toEqual([
      "leads@isolation.invalid",
    ]);
  });

  /**
   * ⚠️ REFUSED, NOT ANSWERED WITH BOTH. A list mixing the two products would
   * look entirely reasonable on screen and be wrong — the customer would see a
   * mailbox they cannot use from the product they are standing in, and could
   * disconnect it from there.
   */
  it("refuses a mailbox list that does not name a product", async () => {
    await request(app.getHttpServer())
      // ⚠️ NO `?module=` — that absence IS the test. A bulk edit adding the
      // parameter everywhere quietly turned this into a duplicate of the test
      // above, which passed and proved nothing.
      .get(`/organisations/${org.id}/mailboxes`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });

  /**
   * ⚠️ THE FOUNDER'S SENTENCE, TESTED LITERALLY: *"if later one is switched off
   * the other one is not impacted and keeps working"*.
   */
  it("switching one product off leaves the other's mailbox untouched", async () => {
    await request(app.getHttpServer())
      .put(`/organisations/${org.id}/modules/email_credit_controller`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false })
      .expect(200);

    // The other product's mailbox is still there, still live, still healthy.
    const leads = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/mailboxes?module=lead_follow_up_email`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(leads.body.mailboxes).toHaveLength(1);
    expect(leads.body.mailboxes[0].healthStatus).toBe("active");

    // And it still reports itself ready — the switch-off did not reach across.
    const byKey = await modules();
    expect(byKey.get("lead_follow_up_email")!.missingCapabilities).not.toContain("mailbox");

    /**
     * ⚠️ AND THE SWITCHED-OFF PRODUCT KEEPS ITS OWN MAILBOX TOO. Turning a
     * product off stops the bill next cycle and leaves the data (ruling 12);
     * disconnecting the customer's grant would make coming back a re-consent
     * they never asked for.
     */
    const stillThere = await owner.emailAccount.findFirst({
      where: {
        organisationId: org.id,
        moduleKey: "email_credit_controller",
        deletedAt: null,
      },
    });
    expect(stillThere).not.toBeNull();
  });
});
