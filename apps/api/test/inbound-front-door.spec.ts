import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withInboundAddress, type EvaPrismaClient } from "@eva/database";
import { PrismaService } from "../src/common/database/prisma.service.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * The front door (Slice 3.1b, ruling 29): the address a customer puts on their
 * website, and the one read in the system that happens before a tenant is known.
 *
 * ⚠️ TWO THINGS HERE ARE UNUSUALLY EXPENSIVE TO GET WRONG.
 *
 * The first is ISSUING TWICE. The address is printed on a website and typed by
 * strangers; a second call quietly minting a second address would leave the
 * published one no longer the live one, and every enquiry sent to it arriving
 * for nobody. Migration 0029's partial unique index is the wall, and the
 * idempotency test below is what proves the service walks into it rather than
 * around it.
 *
 * The second is the ROUTING POLICY. `inbound_address_routing` is a deliberate
 * hole in tenant isolation — it has to be, because an inbound webhook arrives
 * with no organisation attached. Its safety rests entirely on being unable to
 * do anything except match one row by an address the caller already knows, so
 * that is tested from both directions: it finds the row it should, and finds
 * nothing at all in every case where it should not.
 */
describe("The inbound front door", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let otherOrg: FixtureOrg;
  let unentitledOrg: FixtureOrg;
  const tokens = new Map<string, string>();
  let otherToken: string;
  let unentitledToken: string;

  const DOMAIN = "test-inbound.eva.local";

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();

    org = await createOrgWithMembers(
      owner,
      "front-door",
      ["owner", "sales", "finance", "read_only"],
      "Smith & Sons Plumbing Ltd",
      [{ moduleKey: "email_credit_controller" }, { moduleKey: "lead_follow_up_email" }],
    );
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }

    otherOrg = await createOrgWithMembers(owner, "front-door-other", ["owner"], "Other Co", [
      { moduleKey: "lead_follow_up_email" },
    ]);
    otherToken = await signToken({
      sub: otherOrg.members[0]!.authUserId,
      email: otherOrg.members[0]!.email,
    });

    // Holds invoice chasing only — has never bought lead follow-up.
    unentitledOrg = await createOrgWithMembers(
      owner,
      "front-door-unentitled",
      ["owner"],
      "No Leads Ltd",
      [{ moduleKey: "email_credit_controller" }],
    );
    unentitledToken = await signToken({
      sub: unentitledOrg.members[0]!.authUserId,
      email: unentitledOrg.members[0]!.email,
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const getAddress = (token: string, organisationId: string) =>
    request(app.getHttpServer())
      .get(`/organisations/${organisationId}/inbound-address`)
      .set("Authorization", `Bearer ${token}`);

  describe("issuing", () => {
    it("issues an address built from the business name", async () => {
      const response = await getAddress(tokens.get("owner")!, org.id).expect(200);
      const { address } = response.body as { address: string };

      expect(address).toMatch(
        /^smith-sons-plumbing-ltd-[23456789a-z]{6}@test-inbound\.eva\.local$/,
      );
      expect(address).toBe(address.toLowerCase());
    });

    /**
     * ⚠️ THE ONE THAT MATTERS MOST. A screen loads this on every visit, so
     * "issue an address" runs constantly for a customer who already has one. If
     * it ever mints a second, the address on their website stops being the live
     * one and the enquiries sent to it arrive for nobody — with nothing failing
     * anywhere to say so.
     */
    it("returns the SAME address every time, however often it is asked", async () => {
      const first = await getAddress(tokens.get("owner")!, org.id).expect(200);
      const again = await Promise.all([
        getAddress(tokens.get("owner")!, org.id).expect(200),
        getAddress(tokens.get("sales")!, org.id).expect(200),
        getAddress(tokens.get("read_only")!, org.id).expect(200),
      ]);

      for (const response of again) {
        expect(response.body.address).toBe(first.body.address);
      }

      const live = await owner.inboundAddress.count({
        where: { organisationId: org.id, deletedAt: null },
      });
      expect(live, "an organisation must never hold two live front doors").toBe(1);
    });

    it("gives two organisations two different addresses", async () => {
      const mine = await getAddress(tokens.get("owner")!, org.id).expect(200);
      const theirs = await getAddress(otherToken, otherOrg.id).expect(200);
      expect(theirs.body.address).not.toBe(mine.body.address);
      expect(theirs.body.address).toMatch(/^other-co-[23456789a-z]{6}@test-inbound\.eva\.local$/);
    });

    it("records the issue in the audit trail, naming the address", async () => {
      await getAddress(tokens.get("owner")!, org.id).expect(200);
      const entries = await owner.auditLog.findMany({
        where: { organisationId: org.id, action: "inbound_address.issued" },
      });
      expect(entries).toHaveLength(1);
      expect((entries[0]!.metadata as { address: string }).address).toContain("@test-inbound");
    });
  });

  describe("who may ask", () => {
    /**
     * ⚠️ 402, NOT 403, AND THE DIFFERENCE IS THE WHOLE POINT OF THE GATE. A
     * screen has to be able to say "buy the product" rather than "ask an
     * owner"; collapsing the two makes it say the wrong one.
     */
    it("answers 402 for an organisation that has not bought lead follow-up", async () => {
      await getAddress(unentitledToken, unentitledOrg.id).expect(402);
      const issued = await owner.inboundAddress.count({
        where: { organisationId: unentitledOrg.id },
      });
      expect(issued, "no door may be opened for a product nobody bought").toBe(0);
    });

    it("answers 403 for a role that does not carry leads:read", async () => {
      // Finance is deliberately left out of the lead permissions: an unanswered
      // enquiry is not a receivable.
      await getAddress(tokens.get("finance")!, org.id).expect(403);
    });

    it("does not leak another organisation's door", async () => {
      const response = await getAddress(otherToken, org.id);
      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain("@test-inbound");
    });
  });

  /**
   * ⚠️ AN ENVIRONMENT WITH NO INBOUND DOMAIN MUST REFUSE, NOT IMPROVISE.
   * Defaulting to a plausible domain would print an address that receives
   * nothing onto a customer's website — every enquiry lost, no error anywhere.
   * This is the reason `INBOUND_EMAIL_DOMAIN` is optional at boot and refused
   * at use rather than the other way round.
   */
  describe("when the environment has no inbound domain", () => {
    it("refuses to issue an address, and issues nothing", async () => {
      const unconfigured = await createTestApp({ env: { INBOUND_EMAIL_DOMAIN: "" } });
      try {
        const freshOrg = await createOrgWithMembers(
          owner,
          "front-door-unconfigured",
          ["owner"],
          "Unconfigured Ltd",
          [{ moduleKey: "lead_follow_up_email" }],
        );
        const token = await signToken({
          sub: freshOrg.members[0]!.authUserId,
          email: freshOrg.members[0]!.email,
        });

        await request(unconfigured.getHttpServer())
          .get(`/organisations/${freshOrg.id}/inbound-address`)
          .set("Authorization", `Bearer ${token}`)
          .expect(503);

        const issued = await owner.inboundAddress.count({
          where: { organisationId: freshOrg.id },
        });
        expect(issued).toBe(0);
      } finally {
        await unconfigured.close();
      }
    });
  });

  /**
   * The pre-tenant read. `withInboundAddress` is what an inbound webhook will
   * use to turn "this arrived at smith-sons-…@…" into an organisation, and it
   * is the only read in the system that runs without a tenant declared.
   */
  describe("the routing policy: resolving an address with no tenant context", () => {
    const routingLookup = (address: string) =>
      withInboundAddress(app.get(PrismaService).db, address, (tx) =>
        tx.inboundAddress.findFirst({ select: { organisationId: true, address: true } }),
      );

    it("finds the organisation behind an address it is given", async () => {
      const { body } = await getAddress(tokens.get("owner")!, org.id).expect(200);
      const found = await routingLookup(body.address);
      expect(found?.organisationId).toBe(org.id);
    });

    /**
     * ⚠️ THE HOLE MUST BE EXACTLY ONE ROW WIDE. If the policy ever matched more
     * than the address it was handed, the webhook path would become a way to
     * read every customer's door without authenticating at all.
     */
    it("cannot see any other organisation's address while resolving one", async () => {
      const mine = await getAddress(tokens.get("owner")!, org.id).expect(200);
      const theirs = await getAddress(otherToken, otherOrg.id).expect(200);

      const rows = await withInboundAddress(app.get(PrismaService).db, mine.body.address, (tx) =>
        tx.inboundAddress.findMany({ select: { address: true } }),
      );
      expect(rows.map((row) => row.address)).toEqual([mine.body.address]);
      expect(rows.map((row) => row.address)).not.toContain(theirs.body.address);
    });

    it("finds nothing for an address nobody was issued", async () => {
      expect(await routingLookup(`never-issued-aaaaaa@${DOMAIN}`)).toBeNull();
    });

    /** Fails closed, like every other context in the system. */
    it("finds nothing when no address is declared at all", async () => {
      const rows = await app.get(PrismaService).db.inboundAddress.findMany();
      expect(rows).toEqual([]);
    });

    /**
     * ⚠️ A REVOKED DOOR IS A CLOSED DOOR. Revoking is a soft delete plus a new
     * row (migration 0029 never reissues the old address), so routing has to
     * stop at the old one — otherwise revoking would achieve nothing and mail
     * would keep arriving through an address the customer gave up.
     */
    it("finds nothing for an address that has been revoked", async () => {
      const revokedOrg = await createOrgWithMembers(
        owner,
        "front-door-revoked",
        ["owner"],
        "Revoked Ltd",
        [{ moduleKey: "lead_follow_up_email" }],
      );
      const token = await signToken({
        sub: revokedOrg.members[0]!.authUserId,
        email: revokedOrg.members[0]!.email,
      });
      const { body } = await getAddress(token, revokedOrg.id).expect(200);

      expect(await routingLookup(body.address)).not.toBeNull();
      await owner.inboundAddress.updateMany({
        where: { organisationId: revokedOrg.id },
        data: { deletedAt: new Date() },
      });
      expect(await routingLookup(body.address)).toBeNull();
    });
  });

  /**
   * The shape on disk. These are the invariants the webhook will lean on, and
   * every one of them is a CHECK in migration 0029 — asserted here so a change
   * that weakens one is visible in a test rather than in a 500 at 2am.
   */
  describe("what is written", () => {
    it("stores the halves so they always agree with the whole", async () => {
      const { body } = await getAddress(tokens.get("owner")!, org.id).expect(200);
      const row = await owner.inboundAddress.findFirst({
        where: { organisationId: org.id, deletedAt: null },
      });
      expect(row).not.toBeNull();
      expect(`${row!.localPart}@${row!.domain}`).toBe(row!.address);
      expect(row!.address).toBe(body.address);
      expect(row!.domain).toBe(DOMAIN);
    });

    it("refuses an address that is not lowercase", async () => {
      await expect(
        owner.inboundAddress.create({
          data: {
            organisationId: org.id,
            address: `Shouty-aaaaaa@${DOMAIN}`,
            localPart: "Shouty-aaaaaa",
            domain: DOMAIN,
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses to reissue an address that has ever been used", async () => {
      const existing = await owner.inboundAddress.findFirst({
        where: { organisationId: org.id },
      });
      await expect(
        owner.inboundAddress.create({
          data: {
            organisationId: otherOrg.id,
            address: existing!.address,
            localPart: existing!.localPart,
            domain: existing!.domain,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
