import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { createOwnerClient, createTestApp, seedTestDatabase, signToken } from "./support.js";

/**
 * GET /users/me (Slice 0.3): resolves the app users row for the caller,
 * auto-provisioning on first login. Gap G-004: emails MUST be lowercased
 * before write/lookup.
 */
describe("GET /users/me", () => {
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

  it("auto-provisions the user row on first login", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "first.login@test.eva.local" });

    const response = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.authUserId).toBe(sub);
    expect(response.body.email).toBe("first.login@test.eva.local");
  });

  it("returns the same row on subsequent logins (no duplicate provisioning)", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "returning@test.eva.local" });

    const first = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
  });

  it("G-004: lowercases a mixed-case JWT email before storing it", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "G004.FooBar@Test.Eva.Local" });

    const response = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.email).toBe("g004.foobar@test.eva.local");
    const stored = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
    expect(stored.email).toBe("g004.foobar@test.eva.local");
  });

  it("G-004: resolves the same user regardless of JWT email case", async () => {
    const sub = randomUUID();
    const lower = await signToken({ sub, email: "case.user@test.eva.local" });
    const upper = await signToken({ sub, email: "CASE.USER@TEST.EVA.LOCAL" });

    const first = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${lower}`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${upper}`)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.email).toBe("case.user@test.eva.local");
  });

  /**
   * ⚠️ THE 2026-08-11 LOCKOUT. The founder's Supabase account was deleted and
   * recreated; our row still pointed at the dead identity. Every sign-in tried
   * to provision a second row, hit `users_email_key`, and came back as a naked
   * 500 — on every page load, forever, with nothing in the log. This is the
   * shape of that day, and what the product must do instead.
   */
  describe("an address we already know, arriving with a different sign-in identity", () => {
    const seedClaimedEmail = async (email: string): Promise<string> => {
      const userId = randomUUID();
      await owner.user.create({ data: { id: userId, email, authUserId: randomUUID() } });
      return userId;
    };

    it("answers 409 with an explanation, not 500 with silence", async () => {
      const email = "already.claimed@test.eva.local";
      await seedClaimedEmail(email);
      const token = await signToken({ sub: randomUUID(), email });

      const response = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(409);

      expect(response.body.message).toMatch(/already belongs to an Eva account/);
      // The customer must be told what happens next; "Internal server error"
      // told the founder nothing for two hours.
      expect(response.body.message).toMatch(/nothing is lost/i);
    });

    /**
     * ⚠️ THE SECURITY TEST — DO NOT "FIX" THIS INTO AN ADOPTION. Rebinding the
     * existing row because the email matches is the classic-federated merge of
     * the account-pre-hijacking study (arXiv 2205.10174): the row can own an
     * organisation, its customers and its whole invoice book, and a matching
     * address is not proof of a claim on any of it. When invites arrive, the
     * claim must ride on a signed invite naming the row — never on the address.
     */
    it("leaves the existing row bound to the identity it already had", async () => {
      const email = "not.adopted@test.eva.local";
      const userId = await seedClaimedEmail(email);
      const before = await owner.user.findUniqueOrThrow({ where: { id: userId } });
      const intruder = randomUUID();

      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${await signToken({ sub: intruder, email })}`)
        .expect(409);

      const after = await owner.user.findUniqueOrThrow({ where: { id: userId } });
      expect(after.authUserId).toBe(before.authUserId);
      expect(after.authUserId).not.toBe(intruder);
      // And no second row was smuggled in under a different id.
      expect(await owner.user.count({ where: { email } })).toBe(1);
    });

    it("still provisions normally for an address nobody holds", async () => {
      const sub = randomUUID();
      const token = await signToken({ sub, email: "unclaimed@test.eva.local" });

      const response = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(response.body.authUserId).toBe(sub);
    });
  });

  /**
   * The two-day idle sign-out (founder's request, 2026-08-12).
   *
   * ⚠️ ENFORCED HERE AND NOT ONLY IN THE BROWSER, WHICH IS THE ENTIRE POINT.
   * The proxy's cookie gives the customer a page that explains itself; it
   * cannot be the rule, because a stolen session carries that cookie with it
   * and vouches for whoever holds it. These tests speak to the API directly,
   * exactly as a thief with a lifted token would.
   */
  describe("a session left idle", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** Signs somebody in, then rewrites when they were last seen. */
    const userLastSeen = async (email: string, lastSeenAt: Date | null): Promise<string> => {
      const sub = randomUUID();
      const token = await signToken({ sub, email });
      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await owner.user.update({ where: { authUserId: sub }, data: { lastSeenAt } });
      return token;
    };

    it("stamps the first sign-in, so the clock starts", async () => {
      const sub = randomUUID();
      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${await signToken({ sub, email: "stamped@test.eva.local" })}`)
        .expect(200);

      const stored = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      expect(stored.lastSeenAt).toBeInstanceOf(Date);
    });

    it("lets yesterday's session straight back in", async () => {
      const token = await userLastSeen(
        "yesterday@test.eva.local",
        new Date(Date.now() - 1 * DAY_MS),
      );
      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    });

    /**
     * ⚠️ THE CODE IS LOAD-BEARING, NOT DECORATION. A bare 401 sends the web app
     * to /sign-in, where the Supabase cookie is still valid — so the proxy
     * sends them back to /app, which 401s again, forever. The browser needs to
     * tell "stale session" from "bad token" to know it must END the session.
     */
    it("refuses one left for more than two days, and says why in a code", async () => {
      const token = await userLastSeen("idle@test.eva.local", new Date(Date.now() - 3 * DAY_MS));

      const response = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(401);

      expect(response.body.code).toBe("session_idle_timeout");
      expect(response.body.message).toMatch(/idle for two days/i);
    });

    /**
     * ⚠️ THE ONE THAT WOULD HAVE SIGNED OUT THE ENTIRE CUSTOMER BASE ON DEPLOY.
     * Every row has a null `last_seen_at` the moment the column ships. Reading
     * that as "idle since the epoch" ends every live session at once — from a
     * change meant to be invisible to anyone actually using the product.
     */
    it("treats a row it has never seen as fresh, and starts its clock", async () => {
      const token = await userLastSeen("never.seen@test.eva.local", null);

      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const stored = await owner.user.findFirstOrThrow({
        where: { email: "never.seen@test.eva.local" },
      });
      expect(stored.lastSeenAt).toBeInstanceOf(Date);
    });

    /**
     * ⚠️ NOT A WRITE PER REQUEST. The dashboard asks five questions to draw
     * itself, so stamping on every call is five writes per screen, per person,
     * forever — on a free-tier database. Five minutes of imprecision is nothing
     * against a two-day window.
     */
    it("does not rewrite the stamp on every single request", async () => {
      const sub = randomUUID();
      const token = await signToken({ sub, email: "throttled@test.eva.local" });
      const call = () =>
        request(app.getHttpServer())
          .get("/users/me")
          .set("Authorization", `Bearer ${token}`)
          .expect(200);

      await call();
      const first = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      await call();
      const second = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });

      expect(second.lastSeenAt?.toISOString()).toBe(first.lastSeenAt?.toISOString());
    });
  });
});
