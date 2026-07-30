import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { encryptToken } from "../src/common/crypto/token-crypto.js";
import type {
  MicrosoftGraphProvider,
  OAuthTokens,
} from "../src/modules/integrations/microsoft-graph/microsoft-graph-provider.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  TEST_TOKEN_ENCRYPTION_KEY,
  type FixtureOrg,
} from "./support.js";

/**
 * Mailbox connection (Slice 1.6; plan §3): status, OAuth connect/callback,
 * disconnect, test email. The Graph provider is stubbed at the DI boundary
 * (overrideProvider — the invoice-documents §7.4 exception: a REAL external
 * provider cannot run in tests). Everything else is real: Postgres as
 * eva_app, RLS, permissions, crypto, state JWTs.
 */

const SANDBOX_EMAIL = "sandbox@example.com";

const DEFAULT_TOKENS: OAuthTokens = {
  accessToken: "stub-access-token-PLAINTEXT",
  refreshToken: "stub-refresh-token-PLAINTEXT",
  expiresInSeconds: 3600,
  scopes: ["offline_access", "User.Read", "Mail.Read", "Mail.Send"],
};

const REFRESHED_TOKENS: OAuthTokens = {
  accessToken: "stub-access-token-REFRESHED",
  refreshToken: "stub-refresh-token-REFRESHED",
  expiresInSeconds: 3600,
  scopes: ["Mail.Send"],
};

const DEFAULT_PROFILE = { emailAddress: SANDBOX_EMAIL, displayName: "Sandbox Mailbox" };

/** vi.fn-backed stub; reset to these defaults in beforeEach. */
const graphStub = {
  buildAuthorizeUrl: vi.fn((state: string) => `https://stub.test/authorize?state=${state}`),
  exchangeCode: vi.fn(async (): Promise<OAuthTokens> => DEFAULT_TOKENS),
  refreshTokens: vi.fn(async (): Promise<OAuthTokens> => REFRESHED_TOKENS),
  getProfile: vi.fn(async () => DEFAULT_PROFILE),
  sendMail: vi.fn(async (): Promise<void> => undefined),
};

function resetGraphStub(): void {
  graphStub.buildAuthorizeUrl
    .mockClear()
    .mockImplementation((state: string) => `https://stub.test/authorize?state=${state}`);
  graphStub.exchangeCode.mockClear().mockResolvedValue(DEFAULT_TOKENS);
  graphStub.refreshTokens.mockClear().mockResolvedValue(REFRESHED_TOKENS);
  graphStub.getProfile.mockClear().mockResolvedValue(DEFAULT_PROFILE);
  graphStub.sendMail.mockClear().mockResolvedValue(undefined);
}

/** Inserts a live connection with VALID encrypted fixture tokens (1h expiry).
 *  Soft-deletes any existing live rows first — tests share orgs, and the
 *  partial unique index allows only ONE live connection per org (ruling 6). */
async function insertConnectedMailbox(
  owner: EvaPrismaClient,
  organisationId: string,
  overrides: Record<string, unknown> = {},
) {
  await owner.emailAccount.updateMany({
    where: { organisationId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return owner.emailAccount.create({
    data: {
      organisationId,
      provider: "microsoft",
      emailAddress: SANDBOX_EMAIL,
      displayName: "Sandbox Mailbox",
      accessTokenEncrypted: encryptToken("fixture-access-token", TEST_TOKEN_ENCRYPTION_KEY),
      refreshTokenEncrypted: encryptToken("fixture-refresh-token", TEST_TOKEN_ENCRYPTION_KEY),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["Mail.Send"],
      healthStatus: "active",
      ...overrides,
    },
  });
}

describe("Mailboxes (Slice 1.6)", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let otherOrg: FixtureOrg;
  const tokens = new Map<string, string>();

  function tokenFor(roleKey: string): string {
    return tokens.get(roleKey)!;
  }

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    org = await createOrgWithMembers(owner, "mailbox", ["owner", "finance", "sales"]);
    otherOrg = await createOrgWithMembers(owner, "mailbox-other", ["owner"]);
    app = await createTestApp({ graphProvider: graphStub as MicrosoftGraphProvider });
    for (const member of org.members) {
      tokens.set(member.roleKey, await signToken({ sub: member.authUserId, email: member.email }));
    }
    for (const member of otherOrg.members) {
      tokens.set(
        `other-${member.roleKey}`,
        await signToken({ sub: member.authUserId, email: member.email }),
      );
    }
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(resetGraphStub);

  describe("GET .../mailbox (status)", () => {
    it("404s for a non-member (cross-tenant is invisible, BRD 15)", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${otherOrg.id}/mailbox`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });

    it("403s for a member without mailbox:read (sales)", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailbox`)
        .set("Authorization", `Bearer ${tokenFor("sales")}`)
        .expect(403);
    });

    it("200s with connected:false when nothing is connected (finance has mailbox:read)", async () => {
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailbox`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(200);
      expect(response.body).toEqual({
        connected: false,
        provider: null,
        emailAddress: null,
        displayName: null,
        healthStatus: null,
        lastHealthCheckAt: null,
        lastError: null,
        connectedBy: null,
        connectedAt: null,
      });
    });

    it("200s with the sanitized status when connected — never token material", async () => {
      await insertConnectedMailbox(owner, org.id);
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailbox`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      expect(response.body.connected).toBe(true);
      expect(response.body.emailAddress).toBe(SANDBOX_EMAIL);
      expect(response.body.healthStatus).toBe("active");
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain("fixture-access-token");
      expect(raw).not.toContain("fixture-refresh-token");
      expect(response.body).not.toHaveProperty("accessTokenEncrypted");
      expect(response.body).not.toHaveProperty("refreshTokenEncrypted");
    });
  });
});
