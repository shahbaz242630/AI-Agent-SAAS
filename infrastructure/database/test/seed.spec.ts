import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { seed } from "../src/seed.js";
import { TEST_DATABASE_URL } from "./support.js";

/** The six roles defined in BRD 7, seeded in Phase 0 (approved ruling 2). */
const ROLE_KEYS = ["owner", "administrator", "finance", "sales", "reception", "read_only"];

let prisma: EvaPrismaClient;

beforeAll(() => {
  prisma = createPrismaClient(TEST_DATABASE_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function rowCounts(): Promise<Record<string, number>> {
  return {
    roles: await prisma.role.count(),
    organisations: await prisma.organisation.count(),
    settings: await prisma.organisationSettings.count(),
    users: await prisma.user.count(),
    memberships: await prisma.organisationMembership.count(),
  };
}

describe("Phase 0 seed data (BRD 18.6)", () => {
  it("seeds the six BRD 7 roles", async () => {
    await seed(prisma);
    const roles = await prisma.role.findMany({ orderBy: { key: "asc" } });
    expect(roles.map((r) => r.key)).toEqual([...ROLE_KEYS].sort());
  });

  it("creates a clearly-flagged demo organisation with Europe/London settings", async () => {
    await seed(prisma);
    const org = await prisma.organisation.findFirst({
      where: { isDemo: true },
      include: { settings: true },
    });
    expect(org, "demo organisation must exist").not.toBeNull();
    expect(org?.settings?.timezone).toBe("Europe/London");
    expect(org?.settings?.locale).toBe("en-GB");
  });

  it("gives the demo organisation demo users with memberships", async () => {
    await seed(prisma);
    const org = await prisma.organisation.findFirst({ where: { isDemo: true } });
    const memberships = await prisma.organisationMembership.findMany({
      where: { organisationId: org?.id },
    });
    expect(memberships.length).toBeGreaterThan(0);
  });

  it("is idempotent — seeding twice changes no row counts", async () => {
    await seed(prisma);
    const before = await rowCounts();
    await seed(prisma);
    expect(await rowCounts()).toEqual(before);
  });
});
