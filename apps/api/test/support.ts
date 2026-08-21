import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { createPrismaClient, seed, type EvaPrismaClient } from "@eva/database";
import { AppModule } from "../src/app.module.js";
import { API_ENV } from "../src/config/config.module.js";
import type { ApiEnv } from "../src/config/env.js";
import { JwksService } from "../src/platform/authentication/jwks.service.js";
import {
  RECEIVED_MAIL,
  type ReceivedMail,
} from "../src/capabilities/mailbox/inbound/received-mail.js";
import {
  MICROSOFT_GRAPH_PROVIDER,
  type MicrosoftGraphProvider,
} from "../src/capabilities/mailbox/microsoft-graph/microsoft-graph-provider.js";
import {
  MICROSOFT_DISCOVERY,
  UNKNOWN_DOMAIN,
  type MicrosoftDiscovery,
} from "../src/capabilities/mailbox/microsoft-graph/microsoft-discovery.js";

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
/** Shared secret for the Slice 1.5 internal endpoints (matches the guard's env). */
export const TEST_INTERNAL_API_SECRET = "test-internal-secret-0123456789abcdef"; // gitleaks:allow — fake test fixture
/** Slice 1.6 test fixtures — format-valid, non-secret. */
export const TEST_TOKEN_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
);
export const TEST_OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef"; // gitleaks:allow — fake test fixture
/**
 * Slice 3.1b fixtures. The webhook secret must be base64 behind `whsec_`,
 * because that is the shape the verifier decodes — a fixture that is not would
 * let every signature test agree with a verifier wrong in the same way.
 */
export const TEST_RESEND_API_KEY = "re_test_0123456789abcdef"; // gitleaks:allow — fake test fixture
export const TEST_RESEND_WEBHOOK_SECRET =
  "whsec_" + Buffer.from("eva-test-webhook-secret").toString("base64"); // gitleaks:allow — fake test fixture

const testEnv: ApiEnv = {
  NODE_ENV: "test",
  PORT: 0,
  LOG_LEVEL: "fatal",
  WEB_ORIGIN: "http://localhost:3000",
  SUPABASE_URL: TEST_SUPABASE_URL,
  SUPABASE_ANON_KEY: "",
  APP_DATABASE_URL: TEST_APP_DATABASE_URL,
  SENTRY_DSN_API: "",
  INTERNAL_API_SECRET: TEST_INTERNAL_API_SECRET,
  TOKEN_ENCRYPTION_KEY: TEST_TOKEN_ENCRYPTION_KEY,
  OAUTH_STATE_SECRET: TEST_OAUTH_STATE_SECRET,
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret", // gitleaks:allow — fake test fixture
  MICROSOFT_TENANT: "common",
  MICROSOFT_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/microsoft/callback",
  // Slice 3.1b — the domain a customer's enquiries are delivered to. Ruling 34
  // starts on Resend's free `*.resend.app`; a fixture value stands in here.
  INBOUND_EMAIL_DOMAIN: "test-inbound.eva.local",
  RESEND_API_KEY: TEST_RESEND_API_KEY,
  RESEND_WEBHOOK_SECRET: TEST_RESEND_WEBHOOK_SECRET,
  // Slice 3.1b step 3 — Gmail. Format-valid, non-secret.
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret", // gitleaks:allow — fake test fixture
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/google/callback",
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

/**
 * Boots the real AppModule with test env + local JWKS override.
 *
 * `graphProvider` substitutes the Microsoft Graph adapter at the DI boundary
 * (Slice 1.6) — the invoice-documents §7.4 exception: a REAL external provider
 * cannot run in tests. Everything else stays real (Postgres as eva_app, RLS,
 * permissions, crypto, state JWTs).
 */
export async function createTestApp(
  options: {
    graphProvider?: MicrosoftGraphProvider;
    discovery?: MicrosoftDiscovery;
    /**
     * Environment overrides for THIS app instance. Added for 3.1b, where the
     * behaviour worth proving is what happens when `INBOUND_EMAIL_DOMAIN` is
     * NOT set: an environment with no inbound domain must refuse to issue an
     * address rather than invent one, and that path is unreachable without a
     * way to unset it.
     */
    env?: Partial<ApiEnv>;
    /**
     * The inbound mail seam (3.1b). Resend's webhook carries metadata only, so
     * the intake path makes a second call to fetch the message — stubbed here
     * so specs prove the intake logic rather than the network.
     */
    receivedMail?: ReceivedMail;
  } = {},
): Promise<INestApplication> {
  const { getKey } = await testKeys();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_ENV)
    .useValue({ ...testEnv, ...options.env })
    .overrideProvider(JwksService)
    .useValue({ getKey: () => getKey });
  if (options.graphProvider) {
    builder = builder.overrideProvider(MICROSOFT_GRAPH_PROVIDER).useValue(options.graphProvider);
  }
  // Discovery reaches unauthenticated Microsoft endpoints, so it is stubbed by
  // default: no spec may depend on the network, and the real service fails open
  // to "unknown" anyway, which would silently weaken assertions.
  builder = builder
    .overrideProvider(MICROSOFT_DISCOVERY)
    .useValue(options.discovery ?? { describeDomain: async () => UNKNOWN_DOMAIN });
  if (options.receivedMail) {
    builder = builder.overrideProvider(RECEIVED_MAIL).useValue(options.receivedMail);
  }
  const moduleRef = await builder.compile();
  // rawBody matches main.ts: the inbound webhook guard verifies an HMAC over
  // the exact bytes received, and a test app without it would prove nothing.
  const app = moduleRef.createNestApplication({ rawBody: true });
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
  /** Slice 1.6a — override to build a fixture that is deliberately NOT
   *  entitled, which is how the 402 tests get an organisation to fail against. */
  modules: { moduleKey: string; enabled?: boolean; seats?: number }[] = [
    { moduleKey: "email_credit_controller" },
  ],
): Promise<FixtureOrg> {
  const orgId = randomUUID();
  await owner.organisation.create({ data: { id: orgId, name } });
  await owner.organisationSettings.create({
    data: { organisationId: orgId, timezone: "Europe/London", locale: "en-GB" },
  });
  // Mirrors what OrganisationsService.create does for a real signup. Without
  // it every fixture org is un-entitled and each of the ~400 api tests that
  // touches an invoice, import, reminder or mailbox 402s — enforcement fails
  // closed, and fixtures are not exempt from that.
  for (const module of modules) {
    await owner.organisationModule.create({
      data: {
        organisationId: orgId,
        moduleKey: module.moduleKey,
        enabled: module.enabled ?? true,
        source: "manual",
        seats: module.seats ?? 1,
        enabledAt: new Date(),
      },
    });
  }

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
