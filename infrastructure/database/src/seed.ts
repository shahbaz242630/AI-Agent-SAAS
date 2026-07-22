import type { EvaPrismaClient } from "./client.js";

/**
 * Phase 0 seed data (BRD 18.6): demo organisation + settings + the six BRD 7
 * roles + demo users/memberships. Demo rows use deterministic UUIDs and are
 * flagged is_demo so send paths can hard-exclude them (BRD 18.6).
 *
 * Customers/invoices/templates are NOT seeded here — those tables are Phase 1
 * scope (approved ruling 1; Rule 11 prohibits scaffolding them now).
 *
 * The seed is idempotent: everything is an upsert on a stable key.
 */
export const SEED_ROLES = [
  { key: "owner", name: "Organisation Owner" },
  { key: "administrator", name: "Administrator" },
  { key: "finance", name: "Finance User" },
  { key: "sales", name: "Sales User" },
  { key: "reception", name: "Reception User" },
  { key: "read_only", name: "Read-Only User" },
] as const;

export const DEMO_ORGANISATION_ID = "00000000-0000-4000-8000-0000000000de";

const DEMO_USERS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    email: "owner@demo.eva.local",
    fullName: "Demo Owner",
    roleKey: "owner",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    email: "finance@demo.eva.local",
    fullName: "Demo Finance User",
    roleKey: "finance",
  },
] as const;

export async function seed(prisma: EvaPrismaClient): Promise<void> {
  for (const role of SEED_ROLES) {
    await prisma.role.upsert({
      where: { key: role.key },
      update: { name: role.name },
      create: role,
    });
  }

  const organisation = await prisma.organisation.upsert({
    where: { id: DEMO_ORGANISATION_ID },
    update: {},
    create: {
      id: DEMO_ORGANISATION_ID,
      name: "Acme Demo Ltd (DEMO)",
      isDemo: true,
    },
  });

  await prisma.organisationSettings.upsert({
    where: { organisationId: organisation.id },
    update: {},
    create: {
      organisationId: organisation.id,
      timezone: "Europe/London",
      locale: "en-GB",
    },
  });

  for (const demoUser of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { id: demoUser.id },
      update: {},
      create: {
        id: demoUser.id,
        email: demoUser.email,
        fullName: demoUser.fullName,
      },
    });

    const role = await prisma.role.findUniqueOrThrow({ where: { key: demoUser.roleKey } });

    await prisma.organisationMembership.upsert({
      where: {
        organisationId_userId: {
          organisationId: organisation.id,
          userId: user.id,
        },
      },
      update: { roleId: role.id },
      create: {
        organisationId: organisation.id,
        userId: user.id,
        roleId: role.id,
      },
    });
  }
}
