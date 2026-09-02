import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@eva/types";
import type { EvaPrismaClient } from "@eva/database";
import { createOwnerClient, seedTestDatabase } from "./support.js";

/**
 * A mailbox belongs to ONE product — asserted at the level that actually
 * enforces it (slice 3.1c-0, migration 0034, ruling 36).
 *
 * ⚠️ THIS IS A SCHEMA GUARD, NOT A SERVICE TEST. Everything here goes through
 * the raw client on purpose: the rules being proved are indexes and a CHECK,
 * and they must hold for every caller — the API, a background job, a
 * hand-written script at 2am. A test that went through `MailboxesService` would
 * prove the service is careful, which is a different and much weaker claim.
 *
 * ⚠️ FOUR OF THESE SIX WOULD HAVE FAILED BEFORE MIGRATION 0034, WHICH IS THE
 * POINT. "The same address on two products" and "a default per product" were
 * both forbidden by indexes scoped to the organisation; the founder's rule of
 * 2026-09-01 is precisely that they must now be allowed, while the same two
 * rules keep holding WITHIN a product.
 */
describe("A mailbox belongs to one product", () => {
  let owner: EvaPrismaClient;
  let organisationId: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    const organisation = await owner.organisation.findFirst({ where: { deletedAt: null } });
    expect(organisation, "the seed must provide an organisation").toBeDefined();
    organisationId = organisation!.id;
  });

  afterAll(async () => {
    await owner.emailAccount.deleteMany({
      where: { emailAddress: { contains: "@module-test.invalid" } },
    });
    await owner.$disconnect();
  });

  /** A mailbox row, named so the cleanup above can find every one of them. */
  function mailbox(local: string, moduleKey: string, isPrimary = false) {
    return {
      organisationId,
      moduleKey,
      provider: "microsoft",
      emailAddress: `${local}@module-test.invalid`,
      isPrimary,
    };
  }

  /** The module values `email_accounts_module_key_check` actually permits. */
  async function modulesAllowedByTheDatabase(): Promise<string[]> {
    const rows = await owner.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'email_accounts_module_key_check'`,
    );
    expect(rows, "the module_key CHECK constraint must exist").toHaveLength(1);
    // Same shape-agnostic extraction as mailbox-providers.spec.ts: Postgres
    // renders one value as `= 'x'::text` and several as `= ANY (ARRAY[...])`.
    const literals = rows[0]!.definition.match(/'([^']+)'/g) ?? [];
    return literals.map((quoted) => quoted.slice(1, -1)).sort();
  }

  it("the CHECK permits exactly the products we ship", async () => {
    expect(await modulesAllowedByTheDatabase()).toEqual([...MODULE_KEYS].sort());
  });

  it("refuses a product that does not exist", async () => {
    await expect(
      owner.emailAccount.create({ data: mailbox("ghost", "no_such_product") }),
    ).rejects.toThrow();
  });

  /**
   * ⚠️ NO DEFAULT IS THE WHOLE SAFETY PROPERTY. Migration 0034 adds the column
   * with a default, back-fills, then drops it. If a later migration ever
   * restores one, a code path that forgets to name the product stops failing
   * and starts silently filing the mailbox under Invoice Chasing — billing
   * another product's seat with every screen still green. This is the test that
   * notices.
   */
  it("refuses a mailbox that names no product at all", async () => {
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO email_accounts (id, organisation_id, provider, email_address)
         VALUES (gen_random_uuid(), $1, 'microsoft', 'nameless@module-test.invalid')`,
        organisationId,
      ),
    ).rejects.toThrow();
  });

  it("lets the SAME address serve two different products", async () => {
    const chasing = await owner.emailAccount.create({
      data: mailbox("mike", "email_credit_controller"),
    });
    const leads = await owner.emailAccount.create({
      data: mailbox("mike", "lead_follow_up"),
    });

    // Two rows, two grants, two seats — the founder's ruling of 2026-09-01.
    expect(leads.id).not.toBe(chasing.id);
    expect(leads.emailAddress).toBe(chasing.emailAddress);
  });

  it("still refuses the same address TWICE on ONE product", async () => {
    await owner.emailAccount.create({ data: mailbox("dupe", "email_credit_controller") });
    await expect(
      owner.emailAccount.create({ data: mailbox("dupe", "email_credit_controller") }),
    ).rejects.toThrow();
  });

  it("gives each product its own default mailbox", async () => {
    await owner.emailAccount.create({
      data: mailbox("primary-chasing", "email_credit_controller", true),
    });
    // Before 0034 this second insert violated `email_accounts_single_primary_key`,
    // so the second product could never have a default at all.
    const leadPrimary = await owner.emailAccount.create({
      data: mailbox("primary-leads", "lead_follow_up", true),
    });
    expect(leadPrimary.isPrimary).toBe(true);
  });

  it("still refuses TWO defaults on ONE product", async () => {
    await owner.emailAccount.create({
      data: mailbox("first-voice", "voice_credit_controller", true),
    });
    await expect(
      owner.emailAccount.create({ data: mailbox("second-voice", "voice_credit_controller", true) }),
    ).rejects.toThrow();
  });
});
