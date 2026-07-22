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
});
