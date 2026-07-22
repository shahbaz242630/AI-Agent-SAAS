import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  unsignedToken,
} from "./support.js";

/**
 * JWT authentication tests (BRD 9.3/15; Slice 0.3): the global guard verifies
 * Supabase access tokens against the project JWKS. Every failure mode must be
 * a 401 — never a 500, never a pass.
 */
describe("JWT authentication guard", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const owner = createOwnerClient();
    await seedTestDatabase(owner);
    await owner.$disconnect();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a missing Authorization header with 401", async () => {
    await request(app.getHttpServer()).get("/users/me").expect(401);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", "Token abc")
      .expect(401);
  });

  it("rejects an expired token with 401", async () => {
    const token = await signToken({ expiresInSeconds: -60 });
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects a tampered signature with 401", async () => {
    const token = await signToken();
    const [header, payload] = token.split(".");
    // Valid header/payload, garbage signature.
    const forged = `${header}.${payload}.${Buffer.from("forged").toString("base64url")}`;
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${forged}`)
      .expect(401);
  });

  it("rejects a token signed by an unknown key with 401", async () => {
    const { generateKeyPair, SignJWT } = await import("jose");
    const { privateKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: "attacker@eva.local" })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setSubject(randomUUID())
      .setAudience("authenticated")
      .setIssuer("https://test.supabase.local/auth/v1")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects a wrong audience with 401", async () => {
    const token = await signToken({ audience: "service_role" });
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects a wrong issuer with 401", async () => {
    const token = await signToken({ issuer: "https://evil.example.com/auth/v1" });
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects an alg=none token with 401", async () => {
    const token = unsignedToken({ sub: randomUUID(), email: "none@eva.local" });
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("accepts a valid token and returns the caller", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "jwt.valid@test.eva.local" });
    const response = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body.authUserId).toBe(sub);
    expect(response.body.email).toBe("jwt.valid@test.eva.local");
  });

  it("leaves @Public endpoints unauthenticated", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });
});
