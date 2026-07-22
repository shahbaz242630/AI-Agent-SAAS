import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { seed, DEMO_ORGANISATION_ID } from "../src/seed.js";
import { withTenant, withUser } from "../src/tenant.js";
import { TEST_DATABASE_URL } from "./support.js";

const OWNER_URL = TEST_DATABASE_URL;
const APP_URL = OWNER_URL.replace("postgresql://eva:eva@", "postgresql://eva_app:eva_app@");

const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ORG_ID = "00000000-0000-4000-8000-0000000000bb";

let owner: EvaPrismaClient;
let app: EvaPrismaClient;

beforeAll(async () => {
  owner = createPrismaClient(OWNER_URL);
  app = createPrismaClient(APP_URL);
  await seed(owner);
});

afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

describe("withTenant — app-layer tenant context (BRD 15)", () => {
  it("sees the active tenant's rows", async () => {
    const orgs = await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      (tx) => tx.organisation.findMany(),
    );
    expect(orgs.map((o) => o.id)).toEqual([DEMO_ORGANISATION_ID]);
  });

  it("cannot see another tenant's rows", async () => {
    // Create a second org inside its own context (the API's create-org pattern).
    await withTenant(app, { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID }, async (tx) => {
      await tx.organisation.upsert({
        where: { id: SECOND_ORG_ID },
        update: {},
        create: { id: SECOND_ORG_ID, name: "Second Org Ltd" },
      });
    });

    const visibleToDemo = await withTenant(
      app,
      { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID },
      (tx) => tx.organisation.findMany(),
    );
    expect(visibleToDemo.map((o) => o.id)).toEqual([DEMO_ORGANISATION_ID]);

    const visibleToSecond = await withTenant(
      app,
      { organisationId: SECOND_ORG_ID, userId: DEMO_USER_ID },
      (tx) => tx.organisation.findMany(),
    );
    expect(visibleToSecond.map((o) => o.id)).toEqual([SECOND_ORG_ID]);
  });

  it("fails closed: queries outside a tenant context see nothing", async () => {
    const orgs = await app.organisation.findMany();
    expect(orgs).toEqual([]);
  });

  it("rejects writes carrying another tenant's organisation_id", async () => {
    await expect(
      withTenant(app, { organisationId: DEMO_ORGANISATION_ID, userId: DEMO_USER_ID }, (tx) =>
        tx.organisationSettings.create({ data: { organisationId: SECOND_ORG_ID } }),
      ),
    ).rejects.toThrow();
  });
});

describe("withUser — login path (resolve my memberships before picking an org)", () => {
  it("sees only my own memberships", async () => {
    const memberships = await withUser(app, DEMO_USER_ID, (tx) =>
      tx.organisationMembership.findMany(),
    );
    expect(memberships.length).toBeGreaterThan(0);
    expect(memberships.every((m) => m.userId === DEMO_USER_ID)).toBe(true);
  });
});
