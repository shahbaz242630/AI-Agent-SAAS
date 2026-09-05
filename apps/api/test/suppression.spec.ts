import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, withTenant, type EvaPrismaClient } from "@eva/database";
import { seed } from "@eva/database";
import {
  addSuppression,
  correctSuppression,
  isSuppressed,
  listSuppressed,
  personSuppressed,
  suppressedValues,
} from "../src/platform/suppression/suppression.js";
import { createOwnerClient } from "./support.js";

/**
 * The do-not-contact module, exercised directly against Postgres as the runtime
 * role so RLS and the revoked UPDATE/DELETE are real (Slice 1.1, extended
 * 2026-08-21 when corrections arrived).
 *
 * ⚠️ THE TEST THAT MATTERS MOST IS "a genuine request after a correction".
 * Everything else here would have passed against a two-table design that
 * silently dropped a real person's real request on the floor.
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
    /**
     * ⚠️ THE LOG SURVIVES BETWEEN RUNS AND THESE TESTS COUNT ROWS. Nothing here
     * can delete a suppression through the app — that is the whole point — so
     * the OWNER clears these two fixture orgs before each run. Without it a
     * second run against the same database sees `suppress, correct, suppress,
     * correct` where the test asserts two events, and the failure looks like a
     * code defect rather than leftover state. Found by re-running.
     */
    await owner.$executeRaw`DELETE FROM consent_events WHERE organisation_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`;
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

  /**
   * ⚠️ IDEMPOTENCY IS THE APPLICATION'S JOB NOW, NOT THE DATABASE'S. The unique
   * key on (org, channel, value) went with migration 0028 because corrections
   * need a second `suppress` row to exist. This asserts the behaviour survived
   * the move — the guarantee is the same, the thing enforcing it is not.
   */
  it("is idempotent on (org, channel, value)", async () => {
    await asOrgA((tx) =>
      addSuppression(tx, { organisationId: ORG_A, channel: "call", value: "+44 20 7946 0000" }),
    );
    await asOrgA((tx) =>
      addSuppression(tx, { organisationId: ORG_A, channel: "call", value: "+44 20 7946 0000" }),
    );
    const rows = await owner.consentEvent.findMany({
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

  /**
   * ⚠️ THIS IS THE WHOLE REASON THE TABLE BECAME A LOG (2026-08-21). A
   * do-not-contact entered by mistake was permanent for everybody including us:
   * no delete path in the app, and no UPDATE or DELETE grant at the database.
   * "Honour a request permanently" and "any button press is irreversible" are
   * different promises and we were making the second.
   */
  describe("correcting an entry that should never have been made", () => {
    it("stops suppressing, without deleting the entry underneath", async () => {
      await asOrgA((tx) =>
        addSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value: "misclick@example.com",
          reason: "lead_requested",
        }),
      );
      expect(await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", "misclick@example.com"))).toBe(
        true,
      );

      const corrected = await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value: "misclick@example.com",
          reason: "Pressed it on the wrong enquiry",
        }),
      );
      expect(corrected).toBe(true);
      expect(await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", "misclick@example.com"))).toBe(
        false,
      );

      // ⚠️ NOTHING WAS REMOVED. The trail still shows the request was made and
      // then said to be an error — that is correcting a record, not rewriting
      // one, and it is the difference the whole design turns on.
      const rows = await owner.consentEvent.findMany({
        where: { organisationId: ORG_A, channel: "email", value: "misclick@example.com" },
        orderBy: { createdAt: "asc" },
        select: { state: true, reason: true },
      });
      expect(rows.map((row) => row.state)).toEqual(["opted_out", "corrected"]);
      expect(rows[0]!.reason).toBe("lead_requested");
      expect(rows[1]!.reason).toBe("Pressed it on the wrong enquiry");
    });

    /**
     * ⚠️ THE ONE THAT WOULD HAVE SHIPPED BROKEN. Somebody suppressed by
     * mistake, corrected, and then GENUINELY asking six months later must end
     * up unreachable. The obvious two-table design — an entry plus a
     * corrections table — cannot express this: the entry already exists, so the
     * old `upsert(update: {})` writes nothing, the stale correction still wins,
     * and a real person's real request does absolutely nothing with no error
     * anywhere. Suppression must be able to win again.
     */
    it("honours a genuine request made AFTER a correction", async () => {
      const value = "changed-their-mind@example.com";
      await asOrgA((tx) => addSuppression(tx, { organisationId: ORG_A, channel: "email", value }));
      await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value,
          reason: "Recorded against the wrong person",
        }),
      );
      expect(await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", value))).toBe(false);

      await asOrgA((tx) =>
        addSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value,
          reason: "lead_requested",
        }),
      );
      expect(await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", value))).toBe(true);
      expect(await asOrgA((tx) => suppressedValues(tx, ORG_A, "email", [value]))).toEqual(
        new Set([value]),
      );
    });

    it("refuses to correct something that is not currently suppressed", async () => {
      const corrected = await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value: "never-suppressed@example.com",
          reason: "This was a mistake",
        }),
      );
      expect(corrected).toBe(false);
      const rows = await owner.consentEvent.count({
        where: { organisationId: ORG_A, value: "never-suppressed@example.com" },
      });
      expect(rows, "a correction was written for a value nobody suppressed").toBe(0);
    });

    /** A double-submitted form must not stack two corrections. */
    it("is a no-op the second time", async () => {
      const value = "twice-corrected@example.com";
      await asOrgA((tx) => addSuppression(tx, { organisationId: ORG_A, channel: "email", value }));
      const first = await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value,
          reason: "The first correction",
        }),
      );
      const second = await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value,
          reason: "The second correction",
        }),
      );
      expect([first, second]).toEqual([true, false]);
      const corrections = await owner.consentEvent.count({
        where: { organisationId: ORG_A, value, state: "corrected" },
      });
      expect(corrections).toBe(1);
    });

    /**
     * ⚠️ THE DATABASE REFUSES A REASONLESS CORRECTION, NOT JUST THE FORM.
     * Undoing somebody's do-not-contact is the one action here that has to be
     * answerable for later, and "the screen requires it" is a promise a script
     * does not keep. Asserted through the runtime role, by hand, because our
     * own function would never write one.
     */
    it("will not store a correction with no reason, even by hand", async () => {
      await expect(
        asOrgA(
          (tx) =>
            tx.$executeRaw`INSERT INTO consent_events (id, organisation_id, state, channel, value)
                           VALUES (gen_random_uuid(), ${ORG_A}::uuid, 'corrected', 'email', 'no-reason@example.com')`,
        ),
      ).rejects.toThrow();
    });

    /** The screen's list answers "who will Eva not contact", so undone entries go. */
    it("leaves corrected values off the do-not-contact list", async () => {
      const listed = await asOrgA((tx) => listSuppressed(tx, ORG_A));
      const values = listed.map((entry) => entry.value);
      expect(values).toContain("stop@example.com");
      expect(values).not.toContain("misclick@example.com");
      expect(values).not.toContain("twice-corrected@example.com");
    });

    /**
     * ⚠️ A CONSENT IS NOT A CORRECTION (slice 3.3d, migration 0042). The engine
     * (3.5) will write `opted_in` rows for `marketing` into the same table; a
     * NEWER one of those on a do-not-contact value must not read as
     * "contactable", which is why every question in `suppression.ts` is pinned
     * to `purpose = 'all'`. Written by the owner, because the API has no
     * consent writer yet — this is the row the engine will one day write.
     */
    it("ignores a newer marketing consent when asked the do-not-contact question", async () => {
      await owner.consentEvent.create({
        data: {
          organisationId: ORG_A,
          state: "opted_in",
          purpose: "marketing",
          basis: "express",
          source: "form",
          channel: "email",
          value: "stop@example.com",
        },
      });
      expect(await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", "stop@example.com"))).toBe(true);
      const listed = await asOrgA((tx) => listSuppressed(tx, ORG_A));
      expect(listed.filter((entry) => entry.value === "stop@example.com")).toHaveLength(1);
      // Nor does the old name show it: a consent is not a `correct`.
      const viaView = (await asOrgA(
        (tx) =>
          tx.$queryRaw`SELECT action FROM suppression_events WHERE organisation_id = ${ORG_A}::uuid AND value = 'stop@example.com'`,
      )) as { action: string }[];
      expect(viaView.map((row) => row.action)).toEqual(["suppress"]);
    });

    /**
     * ⚠️ THE BULK READ AND THE SINGLE READ MUST NEVER DISAGREE. The invoice
     * book asks in bulk and the send path asks one at a time; if they diverge,
     * the book prints "suppressed" on invoices Eva is happily chasing, or the
     * other way round.
     */
    it("agrees with itself in bulk and one at a time", async () => {
      const values = ["stop@example.com", "misclick@example.com", "never-heard-of@example.com"];
      const bulk = await asOrgA((tx) => suppressedValues(tx, ORG_A, "email", values));
      for (const value of values) {
        const single = await asOrgA((tx) => isSuppressed(tx, ORG_A, "email", value));
        expect(bulk.has(value), `bulk and single disagree about ${value}`).toBe(single);
      }
    });

    /**
     * ⚠️ ONE SUPPRESSED HANDLE IS ENOUGH (ruling 79; ruling 90's gate asks this
     * question). `doNotContact` puts every handle it holds on the list and a
     * correction lifts one at a time, so "the address is clear" is not "the
     * person is contactable" while their number is still on it.
     */
    it("calls a person suppressed while any handle is still on the list", async () => {
      const email = "handles@example.com";
      const phone = "+44 7700 900123";
      await asOrgA((tx) =>
        addSuppression(tx, { organisationId: ORG_A, channel: "email", value: email }),
      );
      await asOrgA((tx) =>
        addSuppression(tx, { organisationId: ORG_A, channel: "call", value: phone }),
      );
      expect(await asOrgA((tx) => personSuppressed(tx, ORG_A, { email, phone }))).toBe(true);

      await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "email",
          value: email,
          reason: "the address was a typo for somebody else's",
        }),
      );
      expect(
        await asOrgA((tx) => personSuppressed(tx, ORG_A, { email, phone })),
        "a corrected address made a person contactable while their number was still listed",
      ).toBe(true);
      expect(await asOrgA((tx) => personSuppressed(tx, ORG_A, { email, phone: null }))).toBe(false);

      await asOrgA((tx) =>
        correctSuppression(tx, {
          organisationId: ORG_A,
          channel: "call",
          value: phone,
          reason: "the number was a typo for somebody else's",
        }),
      );
      expect(await asOrgA((tx) => personSuppressed(tx, ORG_A, { email, phone }))).toBe(false);
      expect(await asOrgA((tx) => personSuppressed(tx, ORG_A, {}))).toBe(false);
    });
  });

  it("cannot be updated or deleted even by the runtime role (BRD hard rule)", async () => {
    await expect(
      asOrgA(
        (tx) =>
          tx.$executeRaw`UPDATE consent_events SET reason = 'tampered' WHERE organisation_id = ${ORG_A}::uuid`,
      ),
    ).rejects.toThrow();

    await expect(
      asOrgA(
        (tx) => tx.$executeRaw`DELETE FROM consent_events WHERE organisation_id = ${ORG_A}::uuid`,
      ),
    ).rejects.toThrow();
  });

  /**
   * Slice 3.3d (migration 0042). The table is `consent_events` now; the old
   * name is a read-only view in the 0028 shape, for hand SQL. It must show the
   * same do-not-contact history in the old words — and take nothing.
   */
  it("still answers under the old name, in the old words, and only for reading", async () => {
    const rows = (await asOrgA(
      (tx) =>
        tx.$queryRaw`SELECT action, reason FROM suppression_events
                     WHERE organisation_id = ${ORG_A}::uuid AND value = 'misclick@example.com'
                     ORDER BY created_at ASC, id ASC`,
    )) as { action: string; reason: string | null }[];
    expect(rows.map((row) => row.action)).toEqual(["suppress", "correct"]);
    expect(rows[1]!.reason).toBe("Pressed it on the wrong enquiry");

    await expect(
      asOrgA(
        (tx) =>
          tx.$executeRaw`INSERT INTO suppression_events (id, organisation_id, action, channel, value)
                         VALUES (gen_random_uuid(), ${ORG_A}::uuid, 'suppress', 'email', 'via-the-view@example.com')`,
      ),
    ).rejects.toThrow(/permission denied|cannot insert/i);
  });
});
