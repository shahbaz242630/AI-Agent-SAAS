import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { MAX_CLIENTS_PER_ALLOCATION, type CustomerAllocationDto } from "@eva/types";
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
 * Client allocation across mailbox seats (Slice 1.6b, Task 3).
 *
 * The subject is not "can a client be filed" — it is the four rules that make
 * filing safe: it fails OPEN (unallocated still gets chased), it is all-or-
 * nothing, it 402s for an organisation that does not hold the product, and it
 * leaves a trail per client rather than per batch.
 */

describe("Client allocation (Slice 1.6b)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  /** Deliberately NOT entitled — how the 402 tests get something to fail against. */
  let bare: FixtureOrg;
  let mailboxA: string;
  let mailboxB: string;
  const tokens = new Map<string, string>();
  const membersByRole = new Map<string, FixtureUser>();

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "allocation", [
      "owner",
      "finance",
      "sales",
      "read_only",
    ]);
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
      membersByRole.set(member.roleKey, member);
    }
    bare = await createOrgWithMembers(owner, "allocation-bare", ["owner"], undefined, []);
    mailboxA = await createMailbox("trade", true);
    mailboxB = await createMailbox("retail", false);
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  async function createMailbox(label: string, isPrimary: boolean, orgId = org.id) {
    const account = await owner.emailAccount.create({
      data: {
        organisationId: orgId,
        provider: "microsoft",
        emailAddress: `${label}-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary,
      },
    });
    return account.id;
  }

  async function createCustomer(name: string, orgId = org.id, emailAccountId?: string) {
    const customer = await owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: orgId,
        name: `${name}-${randomUUID().slice(0, 8)}`,
        ...(emailAccountId ? { emailAccountId } : {}),
      },
    });
    return customer.id;
  }

  function allocationUrl(orgId = org.id) {
    return `/organisations/${orgId}/customers/allocation`;
  }

  async function auditRowsFor(customerId: string) {
    return owner.auditLog.findMany({
      where: { action: "customer.reassigned", entityId: customerId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * PINS THE ROUTE ORDER. `/customers/allocation` also matches
   * `CustomersController`'s `GET :customerId`, whose ParseUUIDPipe would reject
   * the literal "allocation" with a 400. If someone reorders the `controllers`
   * array in customers.module.ts, this is what fails.
   */
  it("resolves /customers/allocation as its own route, not as a customer id", async () => {
    const response = await request(app.getHttpServer())
      .get(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("owner")}`)
      .expect(200);
    expect(response.body).toHaveProperty("allocations");
  });

  it("files a client under a mailbox and audits the move per client", async () => {
    const customerId = await createCustomer("trade-client");
    const response = await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [customerId], emailAccountId: mailboxA })
      .expect(200);

    expect(response.body).toEqual({ moved: 1 });
    const stored = await owner.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.emailAccountId).toBe(mailboxA);

    const [audit] = await auditRowsFor(customerId);
    expect(audit?.metadata).toEqual({ from: null, to: mailboxA });
  });

  /** Ruling 1, and the reason the column is nullable: null is an ACTION. */
  it("un-files a client back to the default with an explicit null", async () => {
    const customerId = await createCustomer("unfile-me", org.id, mailboxA);
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [customerId], emailAccountId: null })
      .expect(200)
      .expect((res) => expect(res.body).toEqual({ moved: 1 }));

    const stored = await owner.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.emailAccountId).toBeNull();
    const [audit] = await auditRowsFor(customerId);
    expect(audit?.metadata).toEqual({ from: mailboxA, to: null });
  });

  /** Trap 3. The whole batch commits together, and every client gets its own
   *  audit row in the same transaction — not one summary row (trap 2). */
  it("moves a batch in one go, one audit row per client", async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, index) => createCustomer(`batch-${index}`)),
    );
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: ids, emailAccountId: mailboxB })
      .expect(200)
      .expect((res) => expect(res.body).toEqual({ moved: 5 }));

    const stored = await owner.customer.findMany({ where: { id: { in: ids } } });
    expect(stored.every((customer) => customer.emailAccountId === mailboxB)).toBe(true);
    for (const id of ids) expect((await auditRowsFor(id)).length).toBe(1);
  });

  /**
   * ALL OR NOTHING. A partial success would report "1 moved" for a request
   * naming two clients and leave the caller guessing which one failed.
   */
  it("moves NOTHING when any client in the batch is unknown", async () => {
    const good = await createCustomer("survivor");
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [good, randomUUID()], emailAccountId: mailboxA })
      .expect(404);

    const stored = await owner.customer.findUniqueOrThrow({ where: { id: good } });
    expect(stored.emailAccountId).toBeNull();
    expect(await auditRowsFor(good)).toEqual([]);
  });

  /** Under RLS another tenant's client is invisible, so 404 is what the query
   *  genuinely returns — not a euphemism for 403 (BRD 15). */
  it("refuses a client belonging to another organisation with 404", async () => {
    const foreign = await createCustomer("foreign", bare.id);
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [foreign], emailAccountId: mailboxA })
      .expect(404);
  });

  /**
   * The other half of the cross-tenant guarantee. Migration 0020's composite
   * foreign key would refuse this at the database; the service turns it into a
   * clean 404 instead of a 500, and this proves the service check is really
   * there rather than relying on the constraint to raise.
   */
  it("refuses a mailbox belonging to another organisation with 404", async () => {
    const foreignMailbox = await createMailbox("foreign-box", false, bare.id);
    const customerId = await createCustomer("victim");
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [customerId], emailAccountId: foreignMailbox })
      .expect(404);

    const stored = await owner.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.emailAccountId).toBeNull();
  });

  it("counts a no-op re-file as zero moved and writes no audit row", async () => {
    const customerId = await createCustomer("already-there", org.id, mailboxA);
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [customerId], emailAccountId: mailboxA })
      .expect(200)
      .expect((res) => expect(res.body).toEqual({ moved: 0 }));

    expect(await auditRowsFor(customerId)).toEqual([]);
  });

  it("does not let a duplicated id inflate the count or double-audit", async () => {
    const customerId = await createCustomer("dupe");
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({ customerIds: [customerId, customerId], emailAccountId: mailboxA })
      .expect(200)
      .expect((res) => expect(res.body).toEqual({ moved: 1 }));

    expect((await auditRowsFor(customerId)).length).toBe(1);
  });

  it("rejects a batch larger than the bound, so one request cannot open an unbounded transaction", async () => {
    await request(app.getHttpServer())
      .put(allocationUrl())
      .set("Authorization", `Bearer ${tokens.get("finance")}`)
      .send({
        customerIds: Array.from({ length: MAX_CLIENTS_PER_ALLOCATION + 1 }, () => randomUUID()),
        emailAccountId: null,
      })
      .expect(400);
  });

  describe("the allocation view", () => {
    it("shows an unallocated client as falling back to the default, never as blank", async () => {
      const customerId = await createCustomer("unfiled");
      const response = await request(app.getHttpServer())
        .get(allocationUrl())
        .set("Authorization", `Bearer ${tokens.get("owner")}`)
        .expect(200);

      const row = (response.body.allocations as CustomerAllocationDto[]).find(
        (entry) => entry.customerId === customerId,
      );
      expect(row).toMatchObject({ emailAccountId: null, isFallback: true });
      // Ruling 1 made visible: it resolves to a real address, so nobody reading
      // this screen concludes the client is not being chased.
      expect(row?.resolvedEmailAddress).toBe(response.body.defaultEmailAddress);
      expect(row?.resolvedEmailAddress).not.toBeNull();
    });

    it("shows an allocated client against its own mailbox, not the default", async () => {
      const customerId = await createCustomer("filed", org.id, mailboxB);
      const response = await request(app.getHttpServer())
        .get(allocationUrl())
        .set("Authorization", `Bearer ${tokens.get("owner")}`)
        .expect(200);

      const row = (response.body.allocations as CustomerAllocationDto[]).find(
        (entry) => entry.customerId === customerId,
      );
      expect(row).toMatchObject({ emailAccountId: mailboxB, isFallback: false });
    });
  });

  /**
   * TRAP 4, and the reason plan decision D1 exists.
   *
   * `customers:read`/`customers:write` are CORE permissions — they never 402,
   * deliberately, so an organisation with no products can still reach the screen
   * that sells it one. Gating allocation on those alone would therefore hand a
   * fully working allocation screen to an organisation that had switched Invoice
   * Chasing OFF. The second `mailbox:read` check is what closes it.
   */
  describe("402 when the organisation has not got Invoice Chasing", () => {
    it("refuses to READ the allocation view", async () => {
      const token = await signToken({
        sub: bare.members[0]!.authUserId,
        email: bare.members[0]!.email,
      });
      await request(app.getHttpServer())
        .get(allocationUrl(bare.id))
        .set("Authorization", `Bearer ${token}`)
        .expect(402);
    });

    it("refuses to WRITE an allocation", async () => {
      const token = await signToken({
        sub: bare.members[0]!.authUserId,
        email: bare.members[0]!.email,
      });
      await request(app.getHttpServer())
        .put(allocationUrl(bare.id))
        .set("Authorization", `Bearer ${token}`)
        .send({ customerIds: [randomUUID()], emailAccountId: null })
        .expect(402);
    });
  });

  describe("role bar", () => {
    /** 403 comes BEFORE 402 in the gate order, so a member whose role cannot
     *  write never learns whether the product is held. */
    it("refuses a read-only member with 403", async () => {
      const customerId = await createCustomer("not-yours");
      await request(app.getHttpServer())
        .put(allocationUrl())
        .set("Authorization", `Bearer ${tokens.get("read_only")}`)
        .send({ customerIds: [customerId], emailAccountId: mailboxA })
        .expect(403);
    });

    it("refuses a non-member with 404, never confirming the organisation exists", async () => {
      const token = await signToken({
        sub: bare.members[0]!.authUserId,
        email: bare.members[0]!.email,
      });
      await request(app.getHttpServer())
        .get(allocationUrl())
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });
});
