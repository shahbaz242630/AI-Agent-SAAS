import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant, type EvaPrismaClient } from "@eva/database";
import { seed } from "@eva/database";
import { addSuppression, isSuppressed } from "../src/common/suppression/suppression.js";
import { createOwnerClient } from "./support.js";

/**
 * Suppression list service-level API (Slice 1.1). No public HTTP endpoints yet:
 * these helpers are exercised directly against Postgres as the runtime role
 * (RLS + revoke enforced).
 */
const APP_DATABASE_URL = "postgresql://eva_app:eva_app@localhost:5432/eva_test";

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER_ID = "00000000-0000-4000-8000-000000000001";

describe("Suppression list: add/check and permanence", () => {
  let app: EvaPrismaClient;
  let owner: EvaPrismaClient;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seed(owner);
    // Fixture orgs for RLS scoping (deterministic UUIDs).
    for (const orgId of [ORG_A, ORG_B]) {
      await owner.organisation.upsert({
        where: { id: orgId },
        update: {},
        create: { id: orgId, name: `Org ${orgId.slice(0, 1).toUpperCase()} Ltd` },
      });
    }
    app = createPrismaClient(APP_DATABASE_URL);
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  async function asOrgA<T>(fn: (tx: EvaPrismaClient) => Promise<T>): Promise<T> {
    return withTenant(app, { organisationId: ORG_A, userId: USER_ID }, fn);
  }

  it("adds a suppression entry and can check it", async () => {
    await asOrgA((tx) =>
      addSuppression(tx, {
        organisationId: ORG_A,
        channel: "email",
        value: "Stop@example.com",
        reason: "Contact asked to stop",
      }),
    );
    const suppressed = await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", "stop@example.com"));
    expect(suppressed).toBe(true);
  });

  it("is idempotent on (org, channel, value)", async () => {
    await asOrgA((tx) =>
      addSuppression(tx, { organisationId: ORG_A, channel: "call", value: "+44 20 7946 0000" }),
    );
    await asOrgA((tx) =>
      addSuppression(tx, { organisationId: ORG_A, channel: "call", value: "+44 20 7946 0000" }),
    );
    const rows = await owner.suppressionEntry.findMany({
      where: { organisationId: ORG_A, channel: "call", value: "+44 20 7946 0000" },
    });
    expect(rows).toHaveLength(1);
  });

  it("does not conflate channels for the same value", async () => {
    const emailOnly = await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", "+44 20 7946 0000"));
    expect(emailOnly).toBe(false);
  });

  it("does not leak across organisations", async () => {
    await withTenant(app, { organisationId: ORG_B, userId: USER_ID }, (tx) =>
      addSuppression(tx, {
        organisationId: ORG_B,
        channel: "email",
        value: "stop@example.com",
      }),
    );

    // Org A still sees its own suppression.
    const inA = await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", "stop@example.com"));
    expect(inA).toBe(true);

    // Org A cannot see Org B's suppression even when asking for the same value.
    const inBfromA = await asOrgA((tx) => isSuppressed(tx, ORG_B, "email", "stop@example.com"));
    expect(inBfromA).toBe(false);
  });

  it("cannot be updated or deleted even by the runtime role (BRD hard rule)", async () => {
    await expect(
      asOrgA(
        (tx) =>
          tx.$executeRaw`UPDATE suppression_list SET reason = 'tampered' WHERE organisation_id = ${ORG_A}::uuid`,
      ),
    ).rejects.toThrow();

    await expect(
      asOrgA(
        (tx) => tx.$executeRaw`DELETE FROM suppression_list WHERE organisation_id = ${ORG_A}::uuid`,
      ),
    ).rejects.toThrow();
  });
});
