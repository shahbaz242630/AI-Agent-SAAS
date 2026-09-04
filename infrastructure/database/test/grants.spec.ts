import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";

/**
 * ⚠️ CONNECTED AS `eva_app`, NOT AS THE OWNER, AND THAT IS THE WHOLE TEST.
 * The owner may do anything; run this file as `eva` and every assertion passes
 * without proving a thing. The same connection `rls.spec.ts` uses, for the same
 * reason — these are tests about what the RUNNING APPLICATION can do.
 */
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgresql://eva_app:eva_app@localhost:5432/eva_test";

let prisma: PrismaClient;

/**
 * What the running application is allowed to destroy (migration 0037).
 *
 * 🚨 THE AUDIT TRAIL WAS NOT APPEND-ONLY, IT WAS ONLY WRITTEN THAT WAY.
 * `audit-log.ts` opens *"Append-only audit trail writer (BRD 15). audit_logs is
 * never updated and never soft-deleted."* That was true of the CODE and had
 * never been true of the DATABASE: `eva_app` held full `UPDATE` and `DELETE`
 * from the day the table was created, because default privileges grant the
 * application role everything on a table the owner creates and **a GRANT only
 * ever adds**. Three migrations have now learned that lesson — 0025, 0035, and
 * 0037, which is the one this file guards.
 *
 * ⚠️ EVERY ASSERTION BELOW ATTEMPTS THE WRITE. Reading
 * `information_schema.role_table_grants` would prove that a grant is absent,
 * which is a different and weaker claim than proving the write is refused — a
 * `BEFORE DELETE` trigger, a second grant through a role, or a future
 * `GRANT ... TO PUBLIC` would all pass a grant-table check and still let the
 * row go. The suite connects as `eva_app`, so trying it is both possible and
 * the only honest test.
 */
describe("What the application may destroy", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_DATABASE_URL }) });
    const [{ current_user: role }] = await prisma.$queryRaw<{ current_user: string }[]>`
      SELECT current_user`;
    /**
     * ⚠️ THE CASE THAT MUST FAIL. Run as the OWNER, every assertion in this
     * file passes vacuously — the owner may do anything, so nothing is refused
     * and the whole file reports green while proving nothing at all.
     */
    expect(role, "these tests only mean something as eva_app").toBe("eva_app");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Attempt a statement and report whether Postgres refused it on privileges. */
  async function refused(statement: string): Promise<boolean> {
    try {
      await prisma.$executeRawUnsafe(statement);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/permission denied/i.test(message)) return true;
      // Any other failure means the probe itself is broken, not that the
      // privilege is absent — a silently mis-typed table name must not read as
      // a pass.
      throw error;
    }
  }

  describe("the audit trail", () => {
    it("cannot be rewritten", async () => {
      expect(await refused(`UPDATE audit_logs SET action = 'tampered'`)).toBe(true);
    });

    it("cannot be deleted", async () => {
      expect(await refused(`DELETE FROM audit_logs`)).toBe(true);
    });

    /**
     * ⚠️ AND IT MUST STILL BE WRITABLE. An append-only trail that cannot be
     * appended to is not safer, it is broken — and every tenant mutation writes
     * one inside its own transaction, so this failing would stop the product.
     */
    it("is still readable, and the grant to insert survives", async () => {
      const grants = await prisma.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'eva_app' AND table_name = 'audit_logs'`;
      const held = grants.map((g) => g.privilege_type).sort();
      expect(held).toEqual(["INSERT", "SELECT"]);
    });
  });

  /**
   * ⚠️ THE GAP THIS AUDIT FOUND AND MIGRATION 0037 DELIBERATELY LEFT OPEN.
   *
   * `eva_app` still holds `DELETE` on every table below. Nothing in the
   * application has ever used it — the whole codebase contains one hard delete,
   * and it is not any of these — so each is retired with `deleted_at` by
   * convention, and by convention alone.
   *
   * It was NOT closed in 0037 because revoking it breaks two things that each
   * need their own thought rather than a bundled fix:
   *
   *   1. six isolation tests probe RLS with a cross-tenant `DELETE`, which
   *      would then fail on privileges BEFORE the policy is consulted — and a
   *      security test rewritten to accommodate a change is how a guard gets
   *      weakened by accident;
   *   2. four `tenant.spec.ts` fixtures clean up with `DELETE` as `eva_app`, so
   *      cleanup would silently stop and the next run would collide on a unique
   *      constraint — which looks nothing like a permissions problem, and took
   *      a while to recognise as one.
   *
   * ⚠️ THIS ASSERTS THE GAP RATHER THAN THE FIX, ON PURPOSE. It fails the day
   * somebody revokes one of these without doing the work above, and it fails
   * the day a new soft-deleted table joins the list unnoticed. Either way the
   * gap stays counted instead of quietly growing. **When the work is done, this
   * block moves wholesale into `NEVER_HARD_DELETED` below.**
   */
  const DELETE_STILL_GRANTED_PENDING_A_SLICE = [
    "organisations",
    "organisation_settings",
    "organisation_memberships",
    "organisation_modules",
    "users",
    "customers",
    "contacts",
    "leads",
    "invoices",
    "invoice_documents",
    "imports",
    "import_rows",
    "email_accounts",
    "reminder_sequences",
    "reminder_steps",
    "scheduled_actions",
    "human_escalations",
    "user_sessions",
  ] as const;

  it.each(DELETE_STILL_GRANTED_PENDING_A_SLICE)(
    "%s can still be hard-deleted — a known, recorded gap",
    async (table) => {
      expect(
        await refused(`DELETE FROM "${table}" WHERE false`),
        `${table} is protected now — move it into NEVER_HARD_DELETED`,
      ).toBe(false);
    },
  );

  /**
   * The tables that ARE protected, each by an explicit REVOKE in the migration
   * that created them. This is the precedent the list above should follow.
   */
  const NEVER_HARD_DELETED = [
    "lead_evidence",
    "consent_events",
    "consent_texts",
    "lead_reply_templates",
    "lead_reply_decisions",
    "inbound_messages",
    // Slice 3.2c (migration 0040): a connection is retired, a delivery is evidence.
    "channel_connections",
    "inbound_channel_messages",
    // Slice 3.3a (migration 0041): a person is retired, a handle is marked
    // inactive, a thread is resolved; a message and an activity are what
    // happened.
    "people",
    "person_identities",
    "pipeline_stages",
    "conversations",
    "messages",
    "activities",
  ] as const;

  it.each(NEVER_HARD_DELETED)("%s cannot be hard-deleted by the application", async (table) => {
    expect(await refused(`DELETE FROM "${table}"`)).toBe(true);
  });

  /**
   * Slice 3.3a. A message is what somebody said and an activity is what
   * happened; neither can be rewritten afterwards — the `lead_evidence` rule,
   * one table over. The two positive controls stop this passing because the
   * whole spine happened to be read-only.
   */
  describe("the spine's written-once tables", () => {
    it.each(["messages", "activities"] as const)("%s cannot be rewritten", async (table) => {
      expect(
        await refused(`UPDATE "${table}" SET organisation_id = organisation_id WHERE false`),
      ).toBe(true);
    });

    it.each(["people", "person_identities", "conversations", "pipeline_stages"] as const)(
      "%s can still be updated — a person is edited, a handle retired, a thread resolved",
      async (table) => {
        expect(
          await refused(`UPDATE "${table}" SET organisation_id = organisation_id WHERE false`),
        ).toBe(false);
      },
    );

    it("the timeline view is readable, and only readable", async () => {
      const grants = await prisma.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'eva_app' AND table_name = 'person_timeline'`;
      expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
    });
  });

  /**
   * Slice 3.3d (migration 0042). The do-not-contact log is `consent_events`;
   * its old name is a view in the old shape, for hand SQL. Same trap as
   * `person_timeline`, one migration later: default privileges hand `eva_app`
   * every verb on a view too, and only an explicit REVOKE takes them back.
   */
  describe("the do-not-contact log", () => {
    it("consent_events cannot be rewritten", async () => {
      expect(await refused(`UPDATE consent_events SET reason = 'tampered' WHERE false`)).toBe(true);
    });

    it("its old name, suppression_events, is a view that is readable, and only readable", async () => {
      // `relkind` is Postgres's one-byte "char", which Prisma cannot read raw.
      const kind = await prisma.$queryRaw<{ relkind: string }[]>`
        SELECT relkind::text AS relkind FROM pg_class WHERE relname = 'suppression_events'`;
      expect(kind).toEqual([{ relkind: "v" }]);
      const grants = await prisma.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'eva_app' AND table_name = 'suppression_events'`;
      expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
    });
  });

  /**
   * ⚠️ THE ONE GENUINE HARD DELETE IN THE WHOLE APPLICATION.
   * `organisations.service.ts` replaces an organisation's permission set with a
   * `deleteMany` then inserts, on a table with no `deleted_at` that is meant to
   * be replaced. It must keep its grant, and this test is here so nobody
   * "completes" the revoke list by adding it and finds out from a customer.
   */
  it("organisation_role_permissions keeps DELETE, because it is genuinely used", async () => {
    expect(await refused(`DELETE FROM organisation_role_permissions WHERE false`)).toBe(false);
  });

  /**
   * ⚠️ ALSO PART OF THE RECORDED GAP. `roles` is seeded reference data, and the
   * application has no business changing which roles exist — let alone removing
   * one out from under a membership that points at it. It still can.
   *
   * Left with the list above rather than fixed alone, because `rls.spec.ts`
   * asserts the runtime role's writes here *"silently affect 0 rows"* — an RLS
   * claim that a privilege refusal would replace with a different, weaker one.
   * Same reasoning, same slice.
   */
  it("roles are still writable by the application — a known, recorded gap", async () => {
    expect(await refused(`DELETE FROM roles WHERE false`)).toBe(false);
  });
});
