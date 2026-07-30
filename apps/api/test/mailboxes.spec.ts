import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { decryptToken, encryptToken } from "../src/common/crypto/token-crypto.js";
import {
  GraphRequestError,
  ReauthRequiredError,
} from "../src/modules/integrations/microsoft-graph/microsoft-graph-provider.js";
import type {
  MicrosoftGraphProvider,
  OAuthTokens,
} from "../src/modules/integrations/microsoft-graph/microsoft-graph-provider.js";
import { signOAuthState, verifyOAuthState } from "../src/modules/mailboxes/oauth-state.js";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  TEST_OAUTH_STATE_SECRET,
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

/** A DIFFERENT 32-byte key — stands in for a rotated TOKEN_ENCRYPTION_KEY. */
const OTHER_TOKEN_KEY = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

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

  describe("POST .../mailbox/connect", () => {
    it("403s for a member without mailbox:manage (finance is read-only)", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/connect`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
    });

    it("404s for a non-member", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${otherOrg.id}/mailbox/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });

    it("200s with an authorize URL whose state binds this org + user (10-min JWT)", async () => {
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      const url = new URL(response.body.authorizeUrl);
      const state = url.searchParams.get("state");
      expect(state).toBeTruthy();
      const claims = await verifyOAuthState(TEST_OAUTH_STATE_SECRET, state!);
      expect(claims.organisationId).toBe(org.id);
      expect(claims.userId).toBe(org.members.find((member) => member.roleKey === "owner")!.id);
    });
  });

  describe("GET /integrations/microsoft/callback (@Public)", () => {
    async function mintState(organisationId = org.id): Promise<string> {
      const ownerMember = org.members.find((member) => member.roleKey === "owner")!;
      return signOAuthState(TEST_OAUTH_STATE_SECRET, {
        organisationId,
        userId: ownerMember.id,
        nonce: randomUUID(),
      });
    }

    it("redirects ?error=consent_denied when Microsoft returns an error", async () => {
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?error=access_denied&state=${await mintState()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=consent_denied",
      );
    });

    /** Microsoft's DEFAULT consent policy blocks Mail scopes for an unverified
     *  publisher, so most real customers meet the "Approval required" screen —
     *  and most are not their own admin. It arrives as error=access_denied like
     *  a plain decline; only the AADSTS code distinguishes it. Telling those
     *  users "you cancelled" is a dead end (founder ruling 2026-07-30). */
    it.each([
      ["AADSTS90094: The grant requires admin permission.", "admin consent required"],
      ["AADSTS90095: consent needs approval.", "admin approval pending"],
    ])("redirects ?error=admin_consent_required for %s", async (description) => {
      const query = new URLSearchParams({
        error: "access_denied",
        error_description: description,
        state: await mintState(),
      });
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?${query.toString()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=admin_consent_required",
      );
    });

    it("still redirects ?error=consent_denied for a genuine user decline (AADSTS65004)", async () => {
      const query = new URLSearchParams({
        error: "access_denied",
        error_description: "AADSTS65004: User declined to consent to access the app.",
        state: await mintState(),
      });
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?${query.toString()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=consent_denied",
      );
    });

    it("redirects ?error=invalid_state for a forged state", async () => {
      const response = await request(app.getHttpServer())
        .get("/integrations/microsoft/callback?code=any&state=forged")
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=invalid_state",
      );
    });

    it("redirects ?error=missing_code for a valid state without a code", async () => {
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?state=${await mintState()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=missing_code",
      );
    });

    it("redirects ?error=exchange_failed when the token exchange rejects", async () => {
      graphStub.exchangeCode.mockRejectedValueOnce(new Error("token endpoint down"));
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=exchange_failed",
      );
    });

    it("happy path: 302 ?connected=1, row upserted with CIPHERTEXT tokens, audit written", async () => {
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?connected=1",
      );
      const account = await owner.emailAccount.findFirstOrThrow({
        where: { organisationId: org.id, deletedAt: null },
      });
      expect(account.emailAddress).toBe(SANDBOX_EMAIL);
      expect(account.provider).toBe("microsoft");
      expect(account.healthStatus).toBe("active");
      expect(account.accessTokenEncrypted).toMatch(/^v1\./);
      expect(account.accessTokenEncrypted).not.toContain("stub-access-token-PLAINTEXT");
      expect(account.refreshTokenEncrypted).not.toContain("stub-refresh-token-PLAINTEXT");
      expect(account.scopes).toContain("Mail.Send");
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { organisationId: org.id, action: "mailbox.connected" },
      });
      expect(audit.entityId).toBe(account.id);
    });

    /**
     * The state is valid for 10 minutes and ruling 4 binds it to an
     * ORGANISATION, not a role — so the initiator can lose mailbox:manage
     * between clicking Connect and finishing consent. RLS would not stop the
     * write (it only checks organisation_id), so the callback re-checks the
     * permission itself and must refuse without spending the code.
     */
    it("refuses a state minted by a user who has since lost mailbox:manage", async () => {
      const financeMember = org.members.find((member) => member.roleKey === "finance")!;
      const state = await signOAuthState(TEST_OAUTH_STATE_SECRET, {
        organisationId: org.id,
        userId: financeMember.id,
        nonce: randomUUID(),
      });
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${state}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=not_authorised",
      );
      expect(graphStub.exchangeCode).not.toHaveBeenCalled();
    });

    it("refuses a state naming an organisation the user does not belong to", async () => {
      const ownerMember = org.members.find((member) => member.roleKey === "owner")!;
      const state = await signOAuthState(TEST_OAUTH_STATE_SECRET, {
        organisationId: otherOrg.id,
        userId: ownerMember.id,
        nonce: randomUUID(),
      });
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${state}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=not_authorised",
      );
      expect(graphStub.exchangeCode).not.toHaveBeenCalled();
      const live = await owner.emailAccount.findMany({
        where: { organisationId: otherOrg.id, deletedAt: null },
      });
      expect(live).toEqual([]);
    });

    it("reconnect replaces the single live connection (partial unique index, ruling 6)", async () => {
      // Start disconnected so the first callback INSERTs and the second
      // UPDATEs: a soft-deleted row must block neither (ruling 6).
      await owner.emailAccount.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
        .expect(302);
      await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake-2&state=${await mintState()}`)
        .expect(302);
      const live = await owner.emailAccount.findMany({
        where: { organisationId: org.id, deletedAt: null },
      });
      expect(live).toHaveLength(1);
    });
  });

  describe("POST .../mailbox/disconnect", () => {
    it("wipes tokens + soft-deletes in one transaction, audited (ruling 8)", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(204);
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.deletedAt).not.toBeNull();
      expect(after.accessTokenEncrypted).toBeNull();
      expect(after.refreshTokenEncrypted).toBeNull();
      expect(after.tokenExpiresAt).toBeNull();
      await owner.auditLog.findFirstOrThrow({
        where: { organisationId: org.id, action: "mailbox.disconnected", entityId: account.id },
      });
    });

    it("404s when nothing is connected", async () => {
      await owner.emailAccount.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });

    it("403s for finance (read-only), 404s cross-tenant", async () => {
      await insertConnectedMailbox(owner, org.id);
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/organisations/${otherOrg.id}/mailbox/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });
  });

  describe("POST .../mailbox/test-email (self-addressed, ruling 7)", () => {
    it("sends with the stored token, stamps health, audits", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      expect(response.body).toEqual({ sent: true, to: SANDBOX_EMAIL });
      expect(graphStub.sendMail).toHaveBeenCalledWith(
        "fixture-access-token",
        expect.objectContaining({ to: SANDBOX_EMAIL }),
      );
      expect(graphStub.refreshTokens).not.toHaveBeenCalled();
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.lastHealthCheckAt).not.toBeNull();
      expect(after.healthStatus).toBe("active");
      await owner.auditLog.findFirstOrThrow({
        where: { organisationId: org.id, action: "mailbox.test_email_sent", entityId: account.id },
      });
    });

    it("refresh-on-use: expired access token refreshes, persists ciphertext, sends with the new token (ruling 10)", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      expect(graphStub.refreshTokens).toHaveBeenCalledWith("fixture-refresh-token");
      expect(graphStub.sendMail).toHaveBeenCalledWith(
        "stub-access-token-REFRESHED",
        expect.objectContaining({ to: SANDBOX_EMAIL }),
      );
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(decryptToken(after.accessTokenEncrypted!, TEST_TOKEN_ENCRYPTION_KEY)).toBe(
        "stub-access-token-REFRESHED",
      );
      expect(decryptToken(after.refreshTokenEncrypted!, TEST_TOKEN_ENCRYPTION_KEY)).toBe(
        "stub-refresh-token-REFRESHED",
      );
    });

    it("invalid_grant on refresh → 400 + health stamped auth_expired", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      graphStub.refreshTokens.mockRejectedValueOnce(new ReauthRequiredError());
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);
      expect(response.body.message).toContain("reconnect");
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.healthStatus).toBe("auth_expired");
      expect(after.lastError).toContain("reconnect");
      // A failed attempt is still an attempt, and the transition is a tenant
      // mutation like any other — it must be timestamped and audited, or
      // "when did this mailbox die?" is unanswerable.
      expect(after.lastHealthCheckAt).not.toBeNull();
      await owner.auditLog.findFirstOrThrow({
        where: { organisationId: org.id, action: "mailbox.auth_expired", entityId: account.id },
      });
    });

    /**
     * TOKEN_ENCRYPTION_KEY rotation is an explicitly supported future operation
     * (that is why the ciphertext carries a `v1` prefix), and plan §8 risk 3
     * names key mishandling. Undecryptable stored tokens must present as a dead
     * grant — otherwise the caller gets an opaque 500 while the settings card
     * still says "Connected", and 1.7's sender fails forever with no signal.
     */
    it("undecryptable stored tokens are treated as a dead grant, not a 500", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        accessTokenEncrypted: encryptToken("token-under-a-different-key", OTHER_TOKEN_KEY),
      });
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);
      expect(response.body.message).toContain("reconnect");
      expect(graphStub.sendMail).not.toHaveBeenCalled();
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.healthStatus).toBe("auth_expired");
    });

    it("Graph failure → 502", async () => {
      await insertConnectedMailbox(owner, org.id);
      graphStub.sendMail.mockRejectedValueOnce(new GraphRequestError("nope", 500));
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(502);
    });

    /**
     * The reason the send path is four committed steps rather than one
     * transaction (founder ruling 2026-07-30): Microsoft rotates the refresh
     * token when it is redeemed, so a rotation must NEVER be undone by a later
     * failure. Here the refresh succeeds and the send then fails — the stored
     * pair must still be the new one. One transaction would roll it back and
     * leave us holding a pair Microsoft has moved past.
     */
    it("keeps a rotated token pair after a later send failure (no rollback of the refresh)", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      graphStub.sendMail.mockRejectedValueOnce(new GraphRequestError("nope", 500));
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(502);
      expect(graphStub.refreshTokens).toHaveBeenCalledWith("fixture-refresh-token");
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(decryptToken(after.accessTokenEncrypted!, TEST_TOKEN_ENCRYPTION_KEY)).toBe(
        "stub-access-token-REFRESHED",
      );
      expect(decryptToken(after.refreshTokenEncrypted!, TEST_TOKEN_ENCRYPTION_KEY)).toBe(
        "stub-refresh-token-REFRESHED",
      );
      expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("404s when nothing is connected; 403s for finance", async () => {
      await owner.emailAccount.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
      await insertConnectedMailbox(owner, org.id);
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
    });

    /** The status endpoint is how the UI learns a reconnect is needed
     *  (ruling 10) — prove the auth_expired stamp actually surfaces. */
    it("surfaces auth_expired through the status endpoint after a dead grant", async () => {
      await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      graphStub.refreshTokens.mockRejectedValueOnce(new ReauthRequiredError());
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailbox/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);
      const status = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailbox`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      expect(status.body.healthStatus).toBe("auth_expired");
      expect(status.body.lastError).toContain("reconnect");
      expect(JSON.stringify(status.body)).not.toContain("fixture-refresh-token");
    });
  });
});
