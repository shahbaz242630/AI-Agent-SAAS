import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { createPrismaClient, seed, type EvaPrismaClient } from "@eva/database";
import { AppModule } from "../src/app.module.js";
import { API_ENV } from "../src/config/config.module.js";
import type { ApiEnv } from "../src/config/env.js";
import { JwksService } from "../src/modules/authentication/jwks.service.js";

/**
 * Shared API test support (BRD 13): the app boots for real against the real
 * test Postgres as the eva_app runtime role. JWTs are signed with a
 * locally-generated ES256 keypair and JWKS resolution is overridden to serve
 * only its public key — no network, no real Supabase tokens.
 */

export const TEST_OWNER_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://eva:eva@localhost:5432/eva_test";
export const TEST_APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgresql://eva_app:eva_app@localhost:5432/eva_test";
export const TEST_SUPABASE_URL = process.env.SUPABASE_URL ?? "https://test.supabase.local";
export const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;

const testEnv: ApiEnv = {
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "fatal",
  WEB_ORIGIN: "http://localhost:3000",
  SUPABASE_URL: TEST_SUPABASE_URL,
  SUPABASE_ANON_KEY: "",
  APP_DATABASE_URL: TEST_APP_DATABASE_URL,
};

interface TestKeys {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  getKey: JWTVerifyGetKey;
}

let keysPromise: Promise<TestKeys> | undefined;

function testKeys(): Promise<TestKeys> {
  keysPromise ??= (async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "ES256";
    return { privateKey, getKey: createLocalJWKSet({ keys: [publicJwk] }) };
  })();
  return keysPromise;
}

export interface TestTokenClaims {
  sub?: string;
  email?: string;
  audience?: string;
  issuer?: string;
  /** Seconds from now; negative for an already-expired token. */
  expiresInSeconds?: number;
}

/** Signs a Supabase-shaped access token with the local test key. */
export async function signToken(claims: TestTokenClaims = {}): Promise<string> {
  const { privateKey } = await testKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email ?? "test@eva.local" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject(claims.sub ?? randomUUID())
    .setAudience(claims.audience ?? "authenticated")
    .setIssuer(claims.issuer ?? TEST_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.expiresInSeconds ?? 3600))
    .sign(privateKey);
}

/** Builds an alg=none token (no signature) — must always be rejected. */
export function unsignedToken(claims: { sub: string; email: string }): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: claims.sub,
    email: claims.email,
    aud: "authenticated",
    iss: TEST_ISSUER,
    iat: now,
    exp: now + 3600,
  })}.`;
}

/** Boots the real AppModule with test env + local JWKS override. */
export async function createTestApp(): Promise<INestApplication> {
  const { getKey } = await testKeys();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_ENV)
    .useValue(testEnv)
    .overrideProvider(JwksService)
    .useValue({ getKey: () => getKey })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** Owner-role (superuser) client for fixtures: bypasses RLS by design. */
export function createOwnerClient(): EvaPrismaClient {
  return createPrismaClient(TEST_OWNER_DATABASE_URL);
}

export async function seedTestDatabase(owner: EvaPrismaClient): Promise<void> {
  // Rerun hygiene: eva_test persists across local runs, and users.email is
  // globally unique — clear previous runs' API-test users (memberships
  // cascade) before seeding. Demo/seed rows are untouched.
  await owner.user.deleteMany({ where: { email: { endsWith: "@test.eva.local" } } });
  await seed(owner);
}

export interface FixtureUser {
  id: string;
  authUserId: string;
  email: string;
  roleKey: string;
}

export interface FixtureOrg {
  id: string;
  name: string;
  members: FixtureUser[];
}

/**
 * Creates an org with settings and one member per requested role.
 * `prefix` keeps emails/ids unique per spec file (specs share eva_test).
 */
export async function createOrgWithMembers(
  owner: EvaPrismaClient,
  prefix: string,
  roleKeys: string[],
  name = `${prefix} Test Org Ltd`,
): Promise<FixtureOrg> {
  const orgId = randomUUID();
  await owner.organisation.create({ data: { id: orgId, name } });
  await owner.organisationSettings.create({
    data: { organisationId: orgId, timezone: "Europe/London", locale: "en-GB" },
  });

  const members: FixtureUser[] = [];
  for (const [index, roleKey] of roleKeys.entries()) {
    const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
    const user: FixtureUser = {
      id: randomUUID(),
      authUserId: randomUUID(),
      email: `${prefix}-${index}-${roleKey}@test.eva.local`,
      roleKey,
    };
    await owner.user.create({
      data: { id: user.id, authUserId: user.authUserId, email: user.email },
    });
    await owner.organisationMembership.create({
      data: { organisationId: orgId, userId: user.id, roleId: role.id },
    });
    members.push(user);
  }
  return { id: orgId, name, members };
}
