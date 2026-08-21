import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { encryptToken } from "../src/common/crypto/token-crypto.js";
import { MailProviderRequestError } from "../src/capabilities/mailbox/microsoft-graph/microsoft-graph-provider.js";
import type {
  MicrosoftGraphProvider,
  SendMailInput,
} from "../src/capabilities/mailbox/microsoft-graph/microsoft-graph-provider.js";
import {
  claimReadyAction,
  releaseStaleClaims,
  STALE_CLAIM_MS,
} from "../src/products/invoice-follow-up/reminders/reminder-sender.service.js";
import type { SendRemindersResult } from "../src/products/invoice-follow-up/reminders/reminder-sender.service.js";
import type { TenantTx } from "../src/platform/permissions/permissions.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  TEST_INTERNAL_API_SECRET,
  TEST_TOKEN_ENCRYPTION_KEY,
  type FixtureOrg,
} from "./support.js";
import type { ReminderActivityDto } from "@eva/types";

/**
 * The reminder sender (Slice 1.7): the half of the lifecycle slice 1.5 stopped
 * short of. Real Postgres as eva_app, real RLS, real tenant transactions; the
 * Graph provider is stubbed at the DI boundary (the §7.4 exception — a real
 * external provider cannot run in tests).
 *
 * The load-bearing assertion in this file is that a due reminder with NO
 * working mailbox stays `ready`. Marking it failed or skipped would be
 * terminal, and the debt would then never be chased at all once the customer
 * reconnected — a silent revenue stall, which is the failure mode this whole
 * design exists to avoid.
 */

const DAY_MS = 86_400_000;

/** Every send the double was asked to make, in order. */
const sentMail: Array<{ accessToken: string } & SendMailInput> = [];
/** Armed to make the next send throw, so the failure path is exercised. */
let sendShouldFail = false;
/** Armed to make the provider answer 429 / 5xx — transient, not a failure. */
let sendTransientStatus: number | null = null;

const graphDouble: MicrosoftGraphProvider = {
  buildAuthorizeUrl: () => "https://login.microsoftonline.test/authorize",
  exchangeCode: () => Promise.reject(new Error("not used")),
  refreshTokens: () => Promise.reject(new Error("not used")),
  getProfile: () => Promise.resolve({ emailAddress: "sandbox@example.com", displayName: null }),
  sendMail: (accessToken: string, input: SendMailInput) => {
    if (sendTransientStatus !== null) {
      return Promise.reject(
        new MailProviderRequestError("too many requests", sendTransientStatus, 30),
      );
    }
    // 400 — a fault in the message itself, which WILL fail again next time.
    if (sendShouldFail) return Promise.reject(new MailProviderRequestError("rejected", 400, null));
    sentMail.push({ accessToken, ...input });
    return Promise.resolve();
  },
  probeMailbox: () => Promise.resolve(),
};

describe("Reminder sender (Slice 1.7)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let ownerUserId: string;
  let ownerToken: string;

  async function createMailbox(overrides: Record<string, unknown> = {}) {
    return owner.emailAccount.create({
      data: {
        organisationId: org.id,
        provider: "microsoft",
        emailAddress: `sender-${randomUUID().slice(0, 8)}@example.com`,
        accessTokenEncrypted: encryptToken("fixture-access-token", TEST_TOKEN_ENCRYPTION_KEY),
        refreshTokenEncrypted: encryptToken("fixture-refresh-token", TEST_TOKEN_ENCRYPTION_KEY),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["Mail.Send"],
        healthStatus: "active",
        isPrimary: true,
        connectedBy: ownerUserId,
        ...overrides,
      },
    });
  }

  /**
   * An overdue invoice with exactly ONE due email action in `ready`.
   *
   * The sequence and its steps are provisioned by the real reconcile sweep, so
   * this exercises genuine rows rather than a hand-built queue; everything the
   * sweep also made ready is then cancelled, leaving one row under test.
   */
  async function createDueReminder(options: { loseEmailAfterScheduling?: boolean } = {}) {
    const suffix = randomUUID().slice(0, 8);
    const customer = await owner.customer.create({
      data: { organisationId: org.id, name: `Sender Customer ${suffix}` },
    });
    const contact = await owner.contact.create({
      data: {
        organisationId: org.id,
        customerId: customer.id,
        name: "Sarah Jenkins",
        email: `debtor-${suffix}@example.test`,
      },
    });
    const invoice = await owner.invoice.create({
      data: {
        organisationId: org.id,
        customerId: customer.id,
        contactId: contact.id,
        invoiceNumber: `SND-${suffix}`,
        amountMinorUnits: 348_000,
        currency: "GBP",
        issueDate: new Date(Date.now() - 40 * DAY_MS),
        dueDate: new Date(Date.now() - 7 * DAY_MS),
        status: "active",
      },
    });

    await reconcile();

    // Keep ONE due email row; cancel the rest so counts are unambiguous.
    const due = await owner.scheduledAction.findMany({
      where: { invoiceId: invoice.id, status: "ready", actionType: "email" },
      orderBy: { scheduledDate: "asc" },
    });
    const keep = due.at(-1);
    if (!keep) throw new Error("fixture: reconcile produced no ready email action");
    await owner.scheduledAction.updateMany({
      where: { invoiceId: invoice.id, id: { not: keep.id }, status: { in: ["pending", "ready"] } },
      data: { status: "cancelled" },
    });

    // An invoice whose contact has no email is INELIGIBLE, so it can never be
    // scheduled in the first place — the only way to reach a due row with no
    // recipient is to lose the address after scheduling, which is exactly what
    // happens in real life when someone clears it on the edit form.
    if (options.loseEmailAfterScheduling) {
      await owner.contact.update({ where: { id: contact.id }, data: { email: null } });
    }
    return {
      invoiceId: invoice.id,
      customerId: customer.id,
      actionId: keep.id,
      recipient: contact.email!,
    };
  }

  /**
   * An invoice that is NOT due yet, so `reconcile` schedules the whole sequence
   * and leaves every row `pending`.
   *
   * ⚠️ NOTHING IS CANCELLED HERE, unlike `createDueReminder`. The point of this
   * fixture is the shape of the plan — six steps in date order — so trimming it
   * to one row would remove the thing under test.
   */
  async function createFutureReminder() {
    const suffix = randomUUID().slice(0, 8);
    const customer = await owner.customer.create({
      data: { organisationId: org.id, name: `Future Customer ${suffix}` },
    });
    const contact = await owner.contact.create({
      data: {
        organisationId: org.id,
        customerId: customer.id,
        name: "Imran Khalid",
        email: `future-${suffix}@example.test`,
      },
    });
    const invoice = await owner.invoice.create({
      data: {
        organisationId: org.id,
        customerId: customer.id,
        contactId: contact.id,
        invoiceNumber: `FUT-${suffix}`,
        amountMinorUnits: 4_571_100,
        currency: "GBP",
        issueDate: new Date(),
        // Far enough out that even `pre_due_3` is still in the future, or the
        // first step would be `ready` and the fixture would be testing the
        // waiting path instead.
        dueDate: new Date(Date.now() + 30 * DAY_MS),
        status: "active",
      },
    });

    await reconcile();
    return { invoiceId: invoice.id, customerId: customer.id };
  }

  /**
   * ⚠️ ASSERT ON THIS ROW, NEVER ON THE RUN'S TOTALS.
   *
   * `/internal/reminders/send` sweeps EVERY organisation, and the whole api
   * suite shares one `eva_test` database — so `result.sent` counts other spec
   * files' organisations too. Asserting `sent === 1` passed this file alone and
   * failed the moment it ran with the suite, reporting 4.
   */
  function mailTo(recipient: string) {
    return sentMail.filter((mail) => mail.to === recipient);
  }

  function reconcile() {
    return request(app.getHttpServer())
      .post("/internal/reminders/reconcile")
      .set("x-internal-secret", TEST_INTERNAL_API_SECRET)
      .expect(200);
  }

  async function send() {
    const response = await request(app.getHttpServer())
      .post("/internal/reminders/send")
      .set("x-internal-secret", TEST_INTERNAL_API_SECRET)
      .expect(200);
    // The real type, not a hand-written copy of it: a restated shape silently
    // stops matching the moment the endpoint grows a field.
    return response.body as SendRemindersResult;
  }

  async function activity(): Promise<ReminderActivityDto> {
    const response = await request(app.getHttpServer())
      .get(`/organisations/${org.id}/reminders/activity`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    return response.body as ReminderActivityDto;
  }

  function statusOf(actionId: string) {
    return owner.scheduledAction
      .findUniqueOrThrow({ where: { id: actionId } })
      .then((row) => row.status);
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp({ graphProvider: graphDouble });
    org = await createOrgWithMembers(owner, "sender", ["owner"]);
    // The mailbox's `connected_by` — a real user, because the sender refuses to
    // invent an actor for a token refresh (see the mailbox_owner_unknown test).
    ownerUserId = org.members[0]!.id;
    ownerToken = await signToken({
      sub: org.members[0]!.authUserId,
      email: org.members[0]!.email,
    });
  });

  afterEachCleanup();

  function afterEachCleanup() {
    beforeEach(async () => {
      sentMail.length = 0;
      sendShouldFail = false;
      sendTransientStatus = null;
      // Each test owns its mailboxes: the partial unique index allows only one
      // primary per organisation, and a leftover would decide the next test.
      await owner.emailAccount.deleteMany({ where: { organisationId: org.id } });
      await owner.scheduledAction.updateMany({
        where: { organisationId: org.id, status: { in: ["pending", "ready"] } },
        data: { status: "cancelled" },
      });
      // ⚠️ Cancelling the rows is NOT enough. `reconcile` is a whole-org sweep,
      // and its backfill step re-schedules any live chased invoice that has no
      // non-cancelled action — which is precisely what the line above creates.
      // Every previous test's invoice would come back, and the send counts
      // climbed 1, 2, 3, 4 across this file until they were retired here.
      await owner.invoice.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    });
  }

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  it("sends a due reminder, marks it sent, and writes the email to the contact", async () => {
    await createMailbox();
    const { actionId, recipient } = await createDueReminder();

    await send();

    expect(await statusOf(actionId)).toBe("sent");

    const mail = mailTo(recipient);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toContain("SND-");
    expect(mail[0]?.bodyText).toContain("Sarah Jenkins");
    // The balance, at the invoice's own currency precision.
    expect(mail[0]?.bodyText).toContain("GBP 3480.00");
  });

  /**
   * THE ONE THAT MATTERS. `resolveSendingMailbox` returns null when every
   * mailbox is dead; the row must survive to be retried, not be closed off.
   */
  describe("when no mailbox can send", () => {
    it("HOLDS the reminder as ready rather than failing or skipping it", async () => {
      // No mailbox at all in the organisation.
      const { actionId, recipient } = await createDueReminder();

      const result = await send();

      expect(mailTo(recipient)).toHaveLength(0);
      expect(result.heldReasons.no_working_mailbox).toBeGreaterThanOrEqual(1);

      const status = await statusOf(actionId);
      expect(status).toBe("ready");
      // Terminal states would strand the debt permanently.
      expect(status).not.toBe("failed");
      expect(status).not.toBe("skipped");
      expect(status).not.toBe("cancelled");
    });

    it("sends the SAME held reminder once a mailbox is connected", async () => {
      const { actionId, recipient } = await createDueReminder();
      await send();
      expect(await statusOf(actionId)).toBe("ready");
      expect(mailTo(recipient)).toHaveLength(0);

      await createMailbox();
      await send();

      expect(await statusOf(actionId)).toBe("sent");
      expect(mailTo(recipient)).toHaveLength(1);
    });

    it("holds when the mailbox has no recorded owner, rather than inventing an actor", async () => {
      await createMailbox({ connectedBy: null });
      const { actionId, recipient } = await createDueReminder();

      const result = await send();

      expect(result.heldReasons.mailbox_owner_unknown).toBeGreaterThanOrEqual(1);
      expect(await statusOf(actionId)).toBe("ready");
      expect(mailTo(recipient)).toHaveLength(0);
    });
  });

  it("holds — never sends — when the contact has lost its email address", async () => {
    await createMailbox();
    const { actionId, recipient } = await createDueReminder({ loseEmailAfterScheduling: true });

    const result = await send();

    expect(result.heldReasons.no_recipient).toBeGreaterThanOrEqual(1);
    expect(mailTo(recipient)).toHaveLength(0);
    expect(await statusOf(actionId)).toBe("ready");
  });

  it("marks the row failed when the message itself is rejected (400)", async () => {
    await createMailbox();
    const { actionId } = await createDueReminder();
    sendShouldFail = true;

    await send();

    expect(await statusOf(actionId)).toBe("failed");
  });

  /**
   * ⚠️ THE SCALE BUG. Rate limiting only happens when there is a lot of mail —
   * i.e. exactly when a real customer's book is big. The first version treated
   * every provider error alike and marked the row `failed`, which is terminal,
   * so a 429 would have binned that reminder permanently and silently.
   */
  describe("a transient provider problem defers the reminder, never bins it", () => {
    for (const status of [429, 500, 503]) {
      it(`status ${status} leaves the row ready to retry`, async () => {
        await createMailbox();
        const { actionId, recipient } = await createDueReminder();
        sendTransientStatus = status;

        const result = await send();

        expect(result.heldReasons.provider_deferred).toBeGreaterThanOrEqual(1);
        expect(await statusOf(actionId)).toBe("ready");
        expect(mailTo(recipient)).toHaveLength(0);

        // And it genuinely goes out once the provider recovers.
        sendTransientStatus = null;
        await send();
        expect(await statusOf(actionId)).toBe("sent");
        expect(mailTo(recipient)).toHaveLength(1);
      });
    }
  });

  /**
   * The claim is what stops a second worker (or a re-run) sending the same
   * reminder twice. A duplicate chase is seen by the customer; nothing else in
   * this system is protected by anything but this.
   */
  it("never sends the same reminder twice, however often the sweep runs", async () => {
    await createMailbox();
    const { actionId, recipient } = await createDueReminder();

    await send();
    await send();

    expect(mailTo(recipient)).toHaveLength(1);
    expect(await statusOf(actionId)).toBe("sent");
  });

  /**
   * ⚠️ THE SEQUENTIAL TEST ABOVE DOES NOT PROVE THE CLAIM, and two mutation
   * runs showed it. Deleting the claim's `status: "ready"` guard left every
   * end-to-end test green — the sweep's read filters `sent` rows out long
   * before the claim is reached — and firing two overlapping sweeps did not
   * catch it either, because the requests never overlapped in the window that
   * matters.
   *
   * So the guard is asserted where it actually lives: claim the same row twice
   * and demand a single winner. That is the ONLY thing standing between a
   * debtor and two identical chasers in one morning.
   */
  it("a reminder can be claimed exactly once, however many workers try", async () => {
    const { actionId } = await createDueReminder();

    const outcomes = await owner.$transaction(async (tx) => {
      const first = await claimReadyAction(tx as unknown as TenantTx, actionId);
      const second = await claimReadyAction(tx as unknown as TenantTx, actionId);
      return [first, second];
    });

    expect(outcomes).toEqual([true, false]);
    expect(await statusOf(actionId)).toBe("claimed");
  });

  it("never emails an internal escalation row", async () => {
    await createMailbox();
    const { invoiceId, recipient } = await createDueReminder();
    // Put the org's escalation step into `ready` as the sweep eventually would.
    const escalation = await owner.scheduledAction.findFirstOrThrow({
      where: { invoiceId, actionType: "internal_escalation" },
    });
    await owner.scheduledAction.update({
      where: { id: escalation.id },
      data: { status: "ready" },
    });

    await send();

    // Exactly one email for this debtor — the email row. The escalation is an
    // internal handover and must never reach a customer's inbox.
    expect(mailTo(recipient)).toHaveLength(1);
    expect(await statusOf(escalation.id)).toBe("ready");
  });

  /**
   * The claim commits BEFORE the send, so two workers cannot both deliver. The
   * documented cost is a row stranded in `claimed` when a process dies in
   * between — which, unrecovered, makes that reminder terminal by accident:
   * exactly what the hold-don't-fail design exists to prevent.
   */
  describe("recovering reminders stranded mid-send", () => {
    /** Backdated with raw SQL — `updatedAt` is @updatedAt and cannot be set. */
    async function strandClaim(actionId: string, ageMs: number) {
      const when = new Date(Date.now() - ageMs);
      await owner.$executeRaw`UPDATE scheduled_actions SET status = 'claimed', updated_at = ${when} WHERE id = ${actionId}::uuid`;
    }

    it("frees an abandoned claim and sends it on the same run", async () => {
      await createMailbox();
      const { actionId, recipient } = await createDueReminder();
      await strandClaim(actionId, STALE_CLAIM_MS + 60_000);

      const result = await send();

      expect(result.recovered).toBeGreaterThanOrEqual(1);
      expect(await statusOf(actionId)).toBe("sent");
      expect(mailTo(recipient)).toHaveLength(1);
    });

    /**
     * ⚠️ THE ONE THAT MATTERS. A claim younger than the threshold may still
     * belong to a sweep that is running RIGHT NOW. Stealing it would release a
     * reminder that is about to be delivered — and the customer would get two.
     * This is why the threshold must stay far above `maxDuration`.
     */
    it("does NOT steal a fresh claim from a run that may still be working", async () => {
      await createMailbox();
      const { actionId, recipient } = await createDueReminder();
      await strandClaim(actionId, 60_000); // one minute old — plausibly live

      const result = await send();

      expect(result.recovered).toBe(0);
      expect(await statusOf(actionId)).toBe("claimed");
      expect(mailTo(recipient)).toHaveLength(0);
    });

    it("releases exactly at the boundary, and not before it", async () => {
      const { actionId } = await createDueReminder();
      await strandClaim(actionId, STALE_CLAIM_MS - 60_000);

      const justInside = await owner.$transaction((tx) =>
        releaseStaleClaims(tx as unknown as TenantTx, new Date(Date.now() - STALE_CLAIM_MS)),
      );
      expect(justInside).toBe(0);

      await strandClaim(actionId, STALE_CLAIM_MS + 60_000);
      const justOutside = await owner.$transaction((tx) =>
        releaseStaleClaims(tx as unknown as TenantTx, new Date(Date.now() - STALE_CLAIM_MS)),
      );
      expect(justOutside).toBe(1);
      expect(await statusOf(actionId)).toBe("ready");
    });

    /** 30 minutes clears Trigger.dev's 300s maxDuration six times over. */
    it("keeps the threshold far above a sweep's worst-case runtime", () => {
      const MAX_SWEEP_DURATION_MS = 300_000;
      expect(STALE_CLAIM_MS).toBeGreaterThan(MAX_SWEEP_DURATION_MS * 5);
    });
  });

  /**
   * ⚠️ THE SCALE TRIPWIRE. These ride back on the task's return value so
   * Trigger.dev's run history plots them without a metrics stack. The sweep is
   * serial and `maxDuration` is 300s, so a climbing `durationMs` is the early
   * warning that it needs concurrency — before a customer's reminders stop.
   */
  describe("every run reports what it did", () => {
    it("returns how many organisations were walked and how long it took", async () => {
      await createMailbox();
      await createDueReminder();

      const result = await send();

      expect(result.organisationsProcessed).toBeGreaterThanOrEqual(1);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    /**
     * A sweep that only reports when something happened is indistinguishable
     * from a sweep that stopped running — and that is the failure that takes
     * longest to notice, because the symptom is nothing at all.
     */
    it("still reports on a run with nothing of its own to do", async () => {
      // No mailbox, no due reminder created by this test — and deliberately no
      // assertion on `sent`, which is a whole-database figure (see mailTo).
      // The point is that the run REPORTS, not that it sent nothing.
      const result = await send();

      expect(result.organisationsProcessed).toBeGreaterThanOrEqual(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.heldReasons).toBeDefined();
    });

    it("counts an organisation as processed even when its batch failed", async () => {
      await createMailbox();
      await createDueReminder();
      sendShouldFail = true;

      const result = await send();

      // A per-invoice failure is isolated; the organisation was still walked.
      expect(result.organisationsProcessed).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * The activity screen (Slice 1.7) — the thing that makes Eva's work visible.
   * Before this, every reminder had been recorded since slice 1.5 and no screen
   * read a single row of it.
   */
  describe("chase activity", () => {
    it("shows a sent reminder against the invoice a human would recognise", async () => {
      await createMailbox();
      const { actionId, invoiceId } = await createDueReminder();
      await send();

      const result = await activity();

      expect(result.counts.sentLast7Days).toBeGreaterThanOrEqual(1);
      const row = result.recent.find((entry) => entry.id === actionId);
      expect(row).toBeDefined();
      expect(row?.status).toBe("sent");
      expect(row?.invoiceId).toBe(invoiceId);
      expect(row?.invoiceNumber).toMatch(/^SND-/);
      expect(row?.customerName).toMatch(/^Sender Customer/);
    });

    /**
     * The reason is DERIVED from mailbox health at read time. A dead mailbox
     * explains every waiting row at once, and the answer changes the moment
     * somebody reconnects — which is exactly why it is not stored on the row.
     */
    it("says WHY reminders are waiting when no mailbox works", async () => {
      const { actionId } = await createDueReminder();
      await send();

      const result = await activity();

      expect(result.counts.waiting).toBeGreaterThanOrEqual(1);
      expect(result.waitingReason).toBe("no_working_mailbox");
      expect(result.recent.find((entry) => entry.id === actionId)?.status).toBe("ready");
    });

    it("stops blaming the mailbox once a working one exists", async () => {
      const { actionId } = await createDueReminder();
      await send();
      expect((await activity()).waitingReason).toBe("no_working_mailbox");

      // Reconnected, but the provider is now refusing — still waiting, but the
      // mailbox is no longer the explanation.
      await createMailbox();
      sendTransientStatus = 429;
      await send();

      const result = await activity();
      expect(await statusOf(actionId)).toBe("ready");
      expect(result.waitingReason).toBe("unknown");
    });

    it("reports nothing waiting, and no reason, once everything has gone out", async () => {
      await createMailbox();
      await createDueReminder();
      await send();

      const result = await activity();

      expect(result.counts.waiting).toBe(0);
      expect(result.waitingReason).toBeNull();
    });

    /**
     * ⚠️ EVA'S FUTURE WORK WAS INVISIBLE, AND SLICE 1.7 IS WHY (found by
     * walking, 2026-08-18). This screen was built to answer "has Eva chased
     * anybody" and answered it by reading only `sent`, `failed`, `ready` and
     * `claimed`. `pending` — the whole plan — was in none of them. So a book
     * whose invoices were not due yet, which is EVERY new customer for their
     * first weeks, showed three zeroes and "Eva simply has not needed to write
     * to anybody" while six reminders sat scheduled in the database.
     *
     * A product that has a plan and a product that has none looked identical,
     * which is the same sentence this screen's own header comment uses about
     * the bug it was created to fix.
     */
    describe("what Eva will do next", () => {
      it("shows the plan for an invoice that is not due yet", async () => {
        const { invoiceId } = await createFutureReminder();

        const result = await activity();

        expect(result.counts.scheduled).toBeGreaterThanOrEqual(1);
        const mine = result.upcoming.filter((row) => row.invoiceId === invoiceId);
        expect(mine.length).toBeGreaterThan(0);
        // The invoice a human recognises, not a database id.
        expect(mine[0]?.invoiceNumber).toMatch(/^FUT-/);
        expect(mine[0]?.customerName).toMatch(/^Future Customer/);
        expect(mine[0]?.status).toBe("pending");
      });

      /**
       * ⚠️ SOONEST FIRST, NOT NEWEST FIRST. `recent` sorts on `updatedAt`
       * because history reads newest-first; a plan reads soonest-first. Reusing
       * the history ordering would put the furthest-away reminder at the top of
       * a list headed "what Eva will do next".
       */
      it("orders the plan by the day it will happen", async () => {
        await createFutureReminder();

        const dates = (await activity()).upcoming.map((row) => row.scheduledDate);

        expect(dates.length).toBeGreaterThan(1);
        expect([...dates].sort()).toEqual(dates);
      });

      /**
       * ⚠️ THE PLAN IS A PROMISE AND THIS IS WHETHER WE CAN KEEP IT. Listing
       * future sends for an organisation with no mailbox is the upload-preview
       * defect again: a screen stating an outcome that will not happen. The old
       * code only asked about mailbox health when something was already
       * WAITING, which is never true for a book that is not due yet.
       */
      it("admits there is nowhere to send from, even with nothing waiting", async () => {
        await createFutureReminder();

        const result = await activity();

        expect(result.counts.waiting).toBe(0);
        expect(result.waitingReason).toBeNull();
        expect(result.noWorkingMailbox).toBe(true);
      });

      it("stops saying so once a mailbox is connected", async () => {
        await createMailbox();
        await createFutureReminder();

        expect((await activity()).noWorkingMailbox).toBe(false);
      });
    });
  });

  /** BRD 14: the audit trail answers "which reminder, when, from where" and
   *  must NOT carry the amount, the body, or the recipient's address. */
  it("audits the send without recording money, message or recipient", async () => {
    await createMailbox();
    const { invoiceId } = await createDueReminder();

    await send();

    const entry = await owner.auditLog.findFirstOrThrow({
      where: { organisationId: org.id, action: "reminder_action.sent", entityId: invoiceId },
    });
    const metadata = JSON.stringify(entry.metadata);
    expect(metadata).toContain("scheduledActionId");
    expect(metadata).toContain("mailboxSource");
    expect(metadata).not.toContain("3480");
    expect(metadata).not.toMatch(/@example\.test/);
    expect(metadata).not.toContain("Sarah");
    // A system actor, not a person: nobody clicked this.
    expect(entry.actorUserId).toBeNull();
  });
});
