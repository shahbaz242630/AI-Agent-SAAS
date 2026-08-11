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
});
