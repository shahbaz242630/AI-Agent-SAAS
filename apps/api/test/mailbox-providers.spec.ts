import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  MAIL_PROVIDER_KEYS,
  MAIL_PROVIDERS,
  providerFor,
  UnknownMailProviderError,
  type MailProviderRegistry,
} from "../src/capabilities/mailbox/mail-provider.js";
import { createOwnerClient, createTestApp, seedTestDatabase } from "./support.js";

/**
 * Which mailbox providers exist — asserted in the two places that must agree
 * (Slice 3.1b, step 2).
 *
 * ⚠️ THIS IS THE GUARD THAT MAKES ADDING A PROVIDER SAFE, AND IT EXISTS BECAUSE
 * BOTH WAYS OF GETTING IT WRONG ARE SILENT.
 *
 *  - **CHECK widened, no adapter registered.** Customers can connect a mailbox
 *    on the new provider, and every send from it fails — after they have
 *    granted access, filed clients against it, and started trusting it.
 *  - **Adapter registered, CHECK not widened.** Nobody can connect one at all;
 *    the connect flow dies on a constraint violation at the last step, after
 *    the customer has approved at the provider.
 *
 * Neither announces itself. Both are found by a customer, not by us.
 */
describe("Mailbox providers: the database and the registry agree", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  /** The provider values `email_accounts_provider_check` actually permits. */
  async function providersAllowedByTheDatabase(): Promise<string[]> {
    const rows = await owner.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'email_accounts_provider_check'`,
    );
    expect(rows, "the provider CHECK constraint must exist").toHaveLength(1);
    /**
     * Postgres renders a one-value CHECK as `(provider = 'microsoft'::text)`
     * and a multi-value one as `provider = ANY (ARRAY['a'::text, 'b'::text])`.
     * Pulling the quoted literals out handles both without caring which shape
     * a future migration produces.
     */
    const literals = rows[0]!.definition.match(/'([^']+)'/g) ?? [];
    return literals.map((quoted) => quoted.slice(1, -1)).sort();
  }

  it("the CHECK constraint permits exactly the providers we claim to support", async () => {
    expect(await providersAllowedByTheDatabase()).toEqual([...MAIL_PROVIDER_KEYS].sort());
  });

  it("every provider we claim to support has an adapter wired in", () => {
    const registry = app.get<MailProviderRegistry>(MAIL_PROVIDERS);
    for (const key of MAIL_PROVIDER_KEYS) {
      const adapter = registry.get(key);
      expect(adapter, `no adapter registered for '${key}'`).toBeDefined();
      // A registered adapter that cannot send is not an adapter.
      expect(typeof adapter!.sendMail).toBe("function");
      expect(typeof adapter!.refreshTokens).toBe("function");
    }
    expect(registry.size).toBe(MAIL_PROVIDER_KEYS.length);
  });

  /**
   * ⚠️ NAMED, NOT `undefined is not a function`. If the two lists ever do drift,
   * the failure has to say which provider is missing — `providerFor` is what
   * turns a mailbox row nobody can serve into a sentence somebody can act on.
   */
  it("names the provider when there is no adapter for it", () => {
    const registry = app.get<MailProviderRegistry>(MAIL_PROVIDERS);
    expect(() => providerFor(registry, "carrier-pigeon")).toThrow(UnknownMailProviderError);
    try {
      providerFor(registry, "carrier-pigeon");
    } catch (error) {
      expect((error as UnknownMailProviderError).provider).toBe("carrier-pigeon");
      expect((error as Error).message).toContain("carrier-pigeon");
    }
  });

  /**
   * ⚠️ THE DATABASE IS STILL THE ARBITER. The registry is a convenience for the
   * application; this is what actually stops a row naming a provider nothing
   * can serve, for every caller including a hand-written script.
   */
  it("the database refuses a provider that is not on the list", async () => {
    const organisation = await owner.organisation.findFirst({ where: { deletedAt: null } });
    await expect(
      owner.emailAccount.create({
        data: {
          organisationId: organisation!.id,
          provider: "carrier-pigeon",
          emailAddress: "nope@example.com",
        },
      }),
    ).rejects.toThrow();
  });
});
