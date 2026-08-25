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

  /**
   * ⚠️ THE ANSWER IS THE DECLARED SHAPE, NOT THE ROW. This endpoint returns
   * whatever the service hands back, and the row carries columns the browser has
   * no business seeing — when this person was last active, and now when this
   * SESSION was, which is a working detail of the rule that refuses stale
   * sessions. Handing an attacker the clock they are trying to beat is a poor
   * idea, and a TypeScript return type does not stop it: types are gone at
   * runtime, so only an explicit projection does.
   */
  it("answers with the user's identity and none of the session bookkeeping", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "shape@test.eva.local" });
    const call = () =>
      request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

    // Both the provisioning answer and the returning-user answer.
    for (const response of [await call(), await call()]) {
      expect(Object.keys(response.body).sort()).toEqual(["authUserId", "email", "fullName", "id"]);
    }
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

    /**
     * Signs somebody in, then rewrites when THIS SESSION was last seen.
     *
     * ⚠️ IT AGES THE SESSION ROW, NOT THE USER ROW, AND THAT IS THE WHOLE POINT
     * OF MIGRATION 0033. The rule reads `user_sessions.last_seen_at`;
     * `users.last_seen_at` is only "last seen anywhere" now. Both are moved here
     * so a test cannot accidentally pass by aging the one nothing reads.
     *
     * `null` means "this session has never been seen" — which is the absence of
     * a row, not a NULL in one.
     */
    const userLastSeen = async (
      email: string,
      lastSeenAt: Date | null,
      sub: string = randomUUID(),
    ): Promise<string> => {
      const token = await signToken({ sub, email });
      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const user = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      if (lastSeenAt === null) {
        await owner.userSession.deleteMany({ where: { userId: user.id } });
      } else {
        await owner.userSession.updateMany({ where: { userId: user.id }, data: { lastSeenAt } });
      }
      await owner.user.update({ where: { id: user.id }, data: { lastSeenAt } });
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
     * 🚨 THE TEST THIS SUITE NEVER HAD — AND THE DEFECT THAT COST A CUSTOMER
     * THEIR ACCOUNT FOR GOOD.
     *
     * Every test around this one proves the door LOCKS. Not one proved there was
     * a key. `admitReturningUser` threw on idle BEFORE the only line in the whole
     * API that writes `last_seen_at`, and that stamp is the only thing the idle
     * check reads — so once it went stale nothing could ever refresh it again,
     * signing in included. The customer's loop was: sign in, 401, get signed out,
     * sign in, 401, with no way out from inside the product. Two days away from
     * Eva — a weekend and a bank holiday — was enough (handoff §9f, measured on
     * production 2026-08-25).
     *
     * ⚠️ THE SECOND SIGN-IN CARRIES A NEW SESSION ID, AND THAT IS THE WHOLE
     * POINT. Signing in again opens a new Supabase session, which is how the
     * server can tell a returning customer from a thief replaying the stolen
     * one — the thief keeps the OLD id and stays refused, which is what the test
     * above holds down. Ruling 37.
     */
    it("lets somebody who was refused sign in again, so the lock has a key", async () => {
      const sub = randomUUID();
      const email = "locked.out@test.eva.local";
      const staleToken = await userLastSeen(email, new Date(Date.now() - 3 * DAY_MS), sub);

      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${staleToken}`)
        .expect(401);

      // A genuine new sign-in: the same person and the same row, on a session
      // Supabase has never issued before.
      const freshToken = await signToken({ sub, email, sessionId: randomUUID() });

      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${freshToken}`)
        .expect(200);

      /**
       * ⚠️ AND THE CLOCK MUST ACTUALLY RESTART. Admitting them without stamping
       * would pass the line above and leave the row exactly as stale as it was —
       * so every later request would look like another brand-new sign-in and the
       * two-day rule would quietly never fire again for anybody.
       */
      const stored = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      expect(Date.now() - (stored.lastSeenAt?.getTime() ?? 0)).toBeLessThan(60_000);
    });

    /**
     * ⚠️ THE NEW SESSION HAS TO BE WRITTEN DOWN THE MOMENT IT ARRIVES, EVEN
     * WHEN THE STAMP IS TOO FRESH TO NEED REWRITING.
     *
     * The throttle exists so an active dashboard does not write five times a
     * screen, and it decides on the CLOCK — which knows nothing about sessions.
     * Sign in again within five minutes of your last click and the throttle says
     * "nothing to do", so the new session is never recorded and the row goes on
     * naming the old one. Everything still looks fine, and it is not: from then
     * on the live session no longer matches the stored one, so when this person
     * does go quiet for two days their return is read as a brand-new sign-in and
     * waved through. The rule stops applying to them, silently and for good.
     *
     * Found by deliberately removing the guard on 2026-08-25 and watching every
     * test stay green.
     */
    it("records the new session even when the stamp is too fresh to rewrite", async () => {
      const sub = randomUUID();
      const email = "quick.reconnect@test.eva.local";
      const second = randomUUID();
      // Signed in a moment ago on one session — the write throttle will decline.
      await userLastSeen(email, new Date(), sub);

      // They sign in again straight away: a second session, minutes later.
      const secondToken = await signToken({ sub, email, sessionId: second });
      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${secondToken}`)
        .expect(200);

      // Now that second session goes quiet for three days and comes back.
      const user = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      await owner.userSession.update({
        where: { userId_sessionId: { userId: user.id, sessionId: second } },
        data: { lastSeenAt: new Date(Date.now() - 3 * DAY_MS) },
      });

      const response = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${secondToken}`)
        .expect(401);

      expect(response.body.code).toBe("session_idle_timeout");
    });

    /**
     * 🚨 THE SECOND DEVICE — WHY ONE STAMP PER PERSON IS NOT ENOUGH.
     *
     * Somebody signs in on a laptop and a phone. The phone is stolen and put in
     * a drawer for three days. The laptop is used every day. With a single
     * column naming "the last session we saw", the two sessions take turns
     * overwriting each other, so the phone always arrives looking DIFFERENT from
     * whatever is stored — i.e. looking like a brand-new sign-in — and is waved
     * through. The busy laptop vouches for the stolen phone, forever.
     *
     * ⚠️ THIS IS NOT HYPOTHETICAL. On 2026-08-25 a Supabase auth session created
     * on 20 August, untouched for five days, was still alive on production and
     * would have been admitted on sight for exactly this reason.
     *
     * The stamp belongs to the SESSION, so each one is judged on its own
     * history: the idle session is refused while the active one carries on.
     */
    it("refuses the session that went quiet even while another one is busy", async () => {
      const sub = randomUUID();
      const email = "two.devices@test.eva.local";
      const laptop = randomUUID();
      const phone = randomUUID();

      const laptopToken = await signToken({ sub, email, sessionId: laptop });
      const phoneToken = await signToken({ sub, email, sessionId: phone });

      // Both sign in, so both are known.
      for (const token of [laptopToken, phoneToken]) {
        await request(app.getHttpServer())
          .get("/users/me")
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
      }

      // The phone goes in a drawer for three days. The laptop does not.
      const stored = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      await owner.userSession.update({
        where: { userId_sessionId: { userId: stored.id, sessionId: phone } },
        data: { lastSeenAt: new Date(Date.now() - 3 * DAY_MS) },
      });

      const refused = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${phoneToken}`)
        .expect(401);
      expect(refused.body.code).toBe("session_idle_timeout");

      // And the laptop is completely unaffected — this is the half that stops
      // the fix being "refuse everybody, nobody complains".
      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${laptopToken}`)
        .expect(200);
    });

    /**
     * ⚠️ THE CASE THAT WOULD KILL THE RULE OUTRIGHT IF WE KEYED ON THE TOKEN.
     * A tab left open over a long weekend does not sit still: Supabase quietly
     * refreshes the access token about every hour, so the JWT arriving on the
     * first request back is one this server has never seen before. It belongs to
     * the SAME session though, and that session has been idle for three days —
     * so it must still be refused. Key this on the token and the rule would
     * never fire for anybody who left a tab open, which is most people.
     */
    it("still refuses an idle session when its token has been refreshed", async () => {
      const sub = randomUUID();
      const email = "refreshed@test.eva.local";
      await userLastSeen(email, new Date(Date.now() - 3 * DAY_MS), sub);

      // A refresh: a brand-new token, same person, same Supabase session.
      const refreshedToken = await signToken({ sub, email });

      const response = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${refreshedToken}`)
        .expect(401);

      expect(response.body.code).toBe("session_idle_timeout");
    });

    /**
     * ⚠️ A MISSING CLAIM MUST NOT BECOME A WAY ROUND THE RULE. Supabase lists
     * `session_id` as required, so a token without one should not exist. If one
     * ever arrives we cannot tell WHICH session is asking, and the safe reading
     * of "I do not know" is the older, stricter per-user stamp — never "this
     * must be a new session, let it in". Getting this backwards would turn
     * "omit a claim" into a way past the rule entirely.
     */
    it("judges a token with no session claim on the stricter per-user stamp", async () => {
      const idle = randomUUID();
      const idleEmail = "no.claim.idle@test.eva.local";
      await userLastSeen(idleEmail, new Date(Date.now() - 3 * DAY_MS), idle);

      const refused = await request(app.getHttpServer())
        .get("/users/me")
        .set(
          "Authorization",
          `Bearer ${await signToken({ sub: idle, email: idleEmail, sessionId: null })}`,
        )
        .expect(401);
      expect(refused.body.code).toBe("session_idle_timeout");

      // And the same token shape is fine for somebody genuinely active, so this
      // is a rule and not just a blanket refusal.
      const active = randomUUID();
      const activeEmail = "no.claim.active@test.eva.local";
      await userLastSeen(activeEmail, new Date(Date.now() - 30 * 60 * 1000), active);

      await request(app.getHttpServer())
        .get("/users/me")
        .set(
          "Authorization",
          `Bearer ${await signToken({ sub: active, email: activeEmail, sessionId: null })}`,
        )
        .expect(200);
    });

    /**
     * ⚠️ THE FALLBACK MUST NOT INVENT A SESSION. A claimless token has no
     * session id, so there is nothing to write a row for — and writing one under
     * a made-up key would give the next real token a stale clock it never
     * earned.
     */
    it("writes no session row for a token that carries no session", async () => {
      const sub = randomUUID();
      const email = "no.claim.no.row@test.eva.local";
      await userLastSeen(email, new Date(Date.now() - 30 * 60 * 1000), sub);
      const user = await owner.user.findUniqueOrThrow({ where: { authUserId: sub } });
      const before = await owner.userSession.count({ where: { userId: user.id } });

      await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", `Bearer ${await signToken({ sub, email, sessionId: null })}`)
        .expect(200);

      expect(await owner.userSession.count({ where: { userId: user.id } })).toBe(before);
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
