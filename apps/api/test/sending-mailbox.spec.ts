import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant, type EvaPrismaClient } from "@eva/database";
import { PrismaService } from "../src/common/database/prisma.service.js";
import { MailboxesService } from "../src/modules/mailboxes/mailboxes.service.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  type FixtureOrg,
} from "./support.js";

/**
 * `resolveSendingMailbox` — which mailbox chases this client, right now
 * (Slice 1.6b, Task 6). The seam slice 1.7 calls once per reminder.
 *
 * Tested directly rather than through HTTP because there is no endpoint: 1.7
 * does not exist yet, and this is the contract it will be built against.
 *
 * ⚠️ The thing under test is that the answer is COMPUTED, never stored
 * (ALLOCATION-SCOPE trap 1). Every case below changes the world and asks again.
 */

describe("resolveSendingMailbox (Slice 1.6b)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let service: MailboxesService;
  let userId: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    service = app.get(MailboxesService);
    org = await createOrgWithMembers(owner, "sending", ["owner"], "Sending Org Ltd", [
      { moduleKey: "email_credit_controller", seats: 4 },
    ]);
    userId = org.members[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(async () => {
    // Allocations first: email_account_id is ON DELETE RESTRICT (migration
    // 0020), so a hard delete of a mailbox with clients filed under it is
    // refused — deliberately.
    await owner.customer.updateMany({
      where: { organisationId: org.id },
      data: { emailAccountId: null },
    });
    await owner.emailAccount.deleteMany({ where: { organisationId: org.id } });
  });

  async function addMailbox(
    label: string,
    options: { isPrimary?: boolean; healthStatus?: string; deleted?: boolean } = {},
  ) {
    return owner.emailAccount.create({
      data: {
        organisationId: org.id,
        provider: "microsoft",
        emailAddress: `${label}-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: options.isPrimary ?? false,
        healthStatus: options.healthStatus ?? "active",
        ...(options.deleted ? { deletedAt: new Date() } : {}),
      },
    });
  }

  async function addClient(emailAccountId?: string) {
    return owner.customer.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        name: `Client ${randomUUID().slice(0, 8)}`,
        ...(emailAccountId ? { emailAccountId } : {}),
      },
    });
  }

  /**
   * Resolve exactly as 1.7 will: inside a tenant transaction, on the APP's
   * connection.
   *
   * ⚠️ Not the `owner` client used for fixtures. `owner` is a superuser, and
   * superusers bypass RLS entirely — resolving through it returned mailboxes
   * belonging to other spec files' organisations sharing `eva_test`, so eight
   * of these tests failed against a stranger's primary mailbox. The service
   * itself only ever runs on the RLS-scoped `eva_app` connection, and a test
   * that does otherwise is not testing the thing that ships.
   */
  function resolve(customer: { emailAccountId: string | null }) {
    return withTenant(app.get(PrismaService).db, { organisationId: org.id, userId }, (tx) =>
      service.resolveSendingMailbox(tx, customer),
    );
  }

  it("uses the client's own mailbox when it is live and healthy", async () => {
    await addMailbox("default", { isPrimary: true });
    const filed = await addMailbox("trade");
    const customer = await addClient(filed.id);

    const result = await resolve(customer);
    expect(result?.account.id).toBe(filed.id);
    expect(result?.source).toBe("allocated");
  });

  /** RULING 1. An unallocated client is chased from the default — never
   *  dropped — and this is the NORMAL state, so it is not a substitution. */
  it("falls back to the default for a client that was never filed", async () => {
    const primary = await addMailbox("default", { isPrimary: true });
    await addMailbox("other");
    const customer = await addClient();

    const result = await resolve(customer);
    expect(result?.account.id).toBe(primary.id);
    expect(result?.source).toBe("default");
  });

  /** RULING 6. The reminder still goes out, from a healthy address belonging to
   *  the same business — and it is reported as a substitution so the settings
   *  screen can warn, or nobody would ever reconnect the dead one. */
  it("substitutes the default when the client's own mailbox has a dead grant", async () => {
    const primary = await addMailbox("default", { isPrimary: true });
    const dead = await addMailbox("trade", { healthStatus: "auth_expired" });
    const customer = await addClient(dead.id);

    const result = await resolve(customer);
    expect(result?.account.id).toBe(primary.id);
    expect(result?.source).toBe("substituted");
  });

  /**
   * THE CASE RULING 6 EXISTS FOR, and the reason it became a ruling rather than
   * an implementation detail.
   *
   * Ruling 1 sends every UNALLOCATED client from the default. So a dead DEFAULT
   * does not strand a handful of specially-filed clients — it strands everyone
   * who was never filed, which is most of them. Holding those reminders would
   * stall the majority of an organisation's chasing, silently.
   */
  it("substitutes a healthy mailbox when the DEFAULT itself is dead", async () => {
    await addMailbox("default", { isPrimary: true, healthStatus: "auth_expired" });
    const survivor = await addMailbox("retail");
    const unfiled = await addClient();

    const result = await resolve(unfiled);
    expect(result?.account.id).toBe(survivor.id);
    expect(result?.source).toBe("substituted");
  });

  it("treats an `error` mailbox as unusable, not just `auth_expired`", async () => {
    const primary = await addMailbox("default", { isPrimary: true });
    const broken = await addMailbox("trade", { healthStatus: "error" });
    const customer = await addClient(broken.id);

    const result = await resolve(customer);
    expect(result?.account.id).toBe(primary.id);
    expect(result?.source).toBe("substituted");
  });

  /**
   * DETERMINISTIC. The same client must not be chased from a different address
   * on each run — a debtor seeing one conversation scattered across three
   * mailboxes is worse than the dead grant that caused it.
   */
  it("picks the same stand-in every time when several are healthy", async () => {
    await addMailbox("default", { isPrimary: true, healthStatus: "auth_expired" });
    const oldest = await addMailbox("first");
    await addMailbox("second");
    await addMailbox("third");
    const customer = await addClient();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await resolve(customer))?.account.id).toBe(oldest.id);
    }
  });

  /** Null is a real outcome. An organisation whose every mailbox is dead must
   *  not send from nowhere — 1.7 decides what to do, this answers honestly. */
  it("returns null when nothing healthy is left", async () => {
    await addMailbox("default", { isPrimary: true, healthStatus: "auth_expired" });
    await addMailbox("other", { healthStatus: "error" });

    expect(await resolve(await addClient())).toBeNull();
  });

  it("returns null when the organisation has no mailbox at all", async () => {
    expect(await resolve(await addClient())).toBeNull();
  });

  it("never picks a disconnected mailbox", async () => {
    const gone = await addMailbox("retired", { deleted: true });
    const primary = await addMailbox("default", { isPrimary: true });

    // Belt and braces: disconnect clears allocations (Task 4), so this state
    // should not arise — but a stale pointer must not resurrect a dead grant.
    const result = await resolve({ emailAccountId: gone.id });
    expect(result?.account.id).toBe(primary.id);
    expect(result?.source).toBe("substituted");
  });

  /**
   * TRAP 1, stated as a test. The answer must follow the world, not a value
   * written when the client was filed.
   */
  it("follows a change of default rather than freezing the old one", async () => {
    const first = await addMailbox("first", { isPrimary: true });
    const second = await addMailbox("second");
    const customer = await addClient();
    expect((await resolve(customer))?.account.id).toBe(first.id);

    await owner.emailAccount.update({ where: { id: first.id }, data: { isPrimary: false } });
    await owner.emailAccount.update({ where: { id: second.id }, data: { isPrimary: true } });

    // Same client, same row, different answer — because nothing was stamped.
    expect((await resolve(customer))?.account.id).toBe(second.id);
  });
});
