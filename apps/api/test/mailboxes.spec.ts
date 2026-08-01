import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import { decryptToken, encryptToken } from "../src/common/crypto/token-crypto.js";
import {
  GraphRequestError,
  MailboxUnavailableError,
  ReauthRequiredError,
} from "../src/modules/integrations/microsoft-graph/microsoft-graph-provider.js";
import type {
  AuthorizeUrlOptions,
  MicrosoftGraphProvider,
  OAuthTokens,
} from "../src/modules/integrations/microsoft-graph/microsoft-graph-provider.js";
import { UNKNOWN_DOMAIN } from "../src/modules/integrations/microsoft-graph/microsoft-discovery.js";
import type { DomainDiscovery } from "../src/modules/integrations/microsoft-graph/microsoft-discovery.js";
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
 * Mailbox connection (Slice 1.6; plan Â§3): status, OAuth connect/callback,
 * disconnect, test email. The Graph provider is stubbed at the DI boundary
 * (overrideProvider â€” the invoice-documents Â§7.4 exception: a REAL external
 * provider cannot run in tests). Everything else is real: Postgres as
 * eva_app, RLS, permissions, crypto, state JWTs.
 */

const SANDBOX_EMAIL = "sandbox@example.com";

/** A DIFFERENT 32-byte key â€” stands in for a rotated TOKEN_ENCRYPTION_KEY. */
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
  buildAuthorizeUrl: vi.fn(
    (state: string, options?: AuthorizeUrlOptions) =>
      `https://stub.test/authorize?state=${state}${
        options?.loginHint ? `&login_hint=${encodeURIComponent(options.loginHint)}` : ""
      }`,
  ),
  exchangeCode: vi.fn(async (): Promise<OAuthTokens> => DEFAULT_TOKENS),
  refreshTokens: vi.fn(async (): Promise<OAuthTokens> => REFRESHED_TOKENS),
  getProfile: vi.fn(async () => DEFAULT_PROFILE),
  sendMail: vi.fn(async (): Promise<void> => undefined),
  probeMailbox: vi.fn(async (): Promise<void> => undefined),
};

/** Discovery is stubbed like the Graph provider: it reaches Microsoft's
 *  unauthenticated endpoints, and its real implementation fails open to
 *  "unknown", which would quietly weaken every assertion below. */
const discoveryStub = {
  describeDomain: vi.fn(async (): Promise<DomainDiscovery> => UNKNOWN_DOMAIN),
};

function resetGraphStub(): void {
  discoveryStub.describeDomain.mockClear().mockResolvedValue(UNKNOWN_DOMAIN);
  graphStub.buildAuthorizeUrl
    .mockClear()
    .mockImplementation(
      (state: string, options?: AuthorizeUrlOptions) =>
        `https://stub.test/authorize?state=${state}${
          options?.loginHint ? `&login_hint=${encodeURIComponent(options.loginHint)}` : ""
        }`,
    );
  graphStub.exchangeCode.mockClear().mockResolvedValue(DEFAULT_TOKENS);
  graphStub.refreshTokens.mockClear().mockResolvedValue(REFRESHED_TOKENS);
  graphStub.getProfile.mockClear().mockResolvedValue(DEFAULT_PROFILE);
  graphStub.sendMail.mockClear().mockResolvedValue(undefined);
  graphStub.probeMailbox.mockClear().mockResolvedValue(undefined);
}

/** Inserts a live connection with VALID encrypted fixture tokens (1h expiry).
 *  Soft-deletes any existing live rows first — not because the schema demands
 *  it any more (slice 1.6a replaced the one-live-mailbox-per-org index with a
 *  one-live-ADDRESS index), but because these specs share an organisation and
 *  every one of them uses the same SANDBOX_EMAIL. Leaving the old row live
 *  would now collide on the address instead. */
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
    // Seats deliberately generous: these specs are about OAuth, tokens and
    // health, and most of them connect while a mailbox already exists. Seat
    // enforcement gets its own fixtures below rather than silently gating
    // every unrelated test in the file.
    org = await createOrgWithMembers(owner, "mailbox", ["owner", "finance", "sales"], undefined, [
      { moduleKey: "email_credit_controller", seats: 5 },
    ]);
    otherOrg = await createOrgWithMembers(owner, "mailbox-other", ["owner"]);
    app = await createTestApp({
      graphProvider: graphStub as MicrosoftGraphProvider,
      discovery: discoveryStub,
    });
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

  describe("GET .../mailboxes (list)", () => {
    it("404s for a non-member (cross-tenant is invisible, BRD 15)", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${otherOrg.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });

    it("403s for a member without mailbox:read (sales)", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor("sales")}`)
        .expect(403);
    });

    it("200s with an EMPTY list when nothing is connected (finance has mailbox:read)", async () => {
      await owner.emailAccount.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(200);
      // Slice 1.6a: an empty list rather than a nullable status object. Seats
      // come back too, so the UI knows whether to offer Connect at all.
      expect(response.body.mailboxes).toEqual([]);
      expect(response.body.seats).toBe(5);
      expect(response.body.seatLimitReached).toBe(false);
    });

    it("200s with the sanitized list when connected â€” never token material", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      const response = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      const listed = response.body.mailboxes.find((row: { id: string }) => row.id === account.id);
      expect(listed.emailAddress).toBe(SANDBOX_EMAIL);
      expect(listed.healthStatus).toBe("active");
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain("fixture-access-token");
      expect(raw).not.toContain("fixture-refresh-token");
      expect(listed).not.toHaveProperty("accessTokenEncrypted");
      expect(listed).not.toHaveProperty("refreshTokenEncrypted");
    });
  });

  /**
   * Mailbox seats (Slice 1.6a Task 7) — supersedes slice 1.6 ruling 6.
   *
   * Its own organisation, with its own seat count, because seat limits gate
   * connect and would otherwise interfere with every unrelated spec above.
   */
  describe("mailbox seats", () => {
    let seatOrg: FixtureOrg;
    let seatToken: string;

    beforeAll(async () => {
      seatOrg = await createOrgWithMembers(owner, "seats", ["owner"], "Seats Org Ltd", [
        { moduleKey: "email_credit_controller", seats: 2 },
      ]);
      const member = seatOrg.members[0]!;
      seatToken = await signToken({ sub: member.authUserId, email: member.email });
    });

    // Not async: supertest's Test is thenable, and awaiting it here would
    // return a Response with no `.expect` left to chain.
    function connect(emailAddress: string): request.Test {
      return request(app.getHttpServer())
        .post(`/organisations/${seatOrg.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${seatToken}`)
        .send({ emailAddress });
    }

    async function addMailbox(address: string, isPrimary = false) {
      return owner.emailAccount.create({
        data: {
          organisationId: seatOrg.id,
          provider: "microsoft",
          emailAddress: address,
          accessTokenEncrypted: encryptToken("fixture-access-token", TEST_TOKEN_ENCRYPTION_KEY),
          refreshTokenEncrypted: encryptToken("fixture-refresh-token", TEST_TOKEN_ENCRYPTION_KEY),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["Mail.Send"],
          healthStatus: "active",
          isPrimary,
        },
      });
    }

    async function clearMailboxes(): Promise<void> {
      await owner.emailAccount.deleteMany({ where: { organisationId: seatOrg.id } });
    }

    it("connecting below the limit is allowed", async () => {
      await clearMailboxes();
      await addMailbox("one@seats.example", true);
      await connect("two@seats.example").expect(200);
    });

    /** The friendly pre-check. Refusing here means nobody is sent to Microsoft
     *  to grant Eva access to their mail and THEN told it was pointless. */
    it("refuses before sending anyone to Microsoft once every seat is taken", async () => {
      await clearMailboxes();
      await addMailbox("one@seats.example", true);
      await addMailbox("two@seats.example");
      const response = await connect("three@seats.example").expect(400);
      expect(response.body.message).toContain("seats");
      expect(graphStub.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    /** Reconnecting an address reuses its row and consumes no new seat.
     *  Refusing it would strand a customer whose only mailbox has an expired
     *  grant at exactly the moment they are trying to fix it. */
    it("always allows reconnecting an address that already has a seat, even when full", async () => {
      await clearMailboxes();
      await addMailbox("one@seats.example", true);
      await addMailbox("two@seats.example");
      await connect("two@seats.example").expect(200);
      // Case-insensitively, because Microsoft is and the index is.
      await connect("TWO@seats.example").expect(200);
    });

    it("the callback refuses the connection and stores nothing when full", async () => {
      await clearMailboxes();
      await addMailbox("one@seats.example", true);
      await addMailbox("two@seats.example");
      graphStub.getProfile.mockResolvedValueOnce({
        emailAddress: "three@seats.example",
        displayName: "Third",
      });
      const state = await signOAuthState(TEST_OAUTH_STATE_SECRET, {
        organisationId: seatOrg.id,
        userId: seatOrg.members[0]!.id,
        nonce: randomUUID(),
      });

      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${state}`)
        .expect(302);

      expect(response.headers.location).toContain("error=seat_limit_reached");
      const live = await owner.emailAccount.count({
        where: { organisationId: seatOrg.id, deletedAt: null },
      });
      expect(live).toBe(2);
    });

    /**
     * THE RACE, and it is the reason the callback locks the module row.
     *
     * A COUNT followed by an INSERT is not atomic just because both sit in a
     * transaction. Two administrators connecting at the same moment each read
     * `count = seats - 1`, each decide there is room, and both insert — the
     * organisation ends up over its limit with no error raised anywhere.
     *
     * This test FAILS without `SELECT … FOR UPDATE`, and would pass vacuously
     * if the two callbacks were awaited in sequence — the same class of
     * mistake as the eight RLS INSERT tests that passed on a not-null
     * violation. They must be in flight together.
     */
    it("two simultaneous connects with ONE seat left: exactly one wins", async () => {
      await clearMailboxes();
      await addMailbox("one@seats.example", true);

      graphStub.getProfile
        .mockResolvedValueOnce({ emailAddress: "racer-a@seats.example", displayName: "A" })
        .mockResolvedValueOnce({ emailAddress: "racer-b@seats.example", displayName: "B" });

      const mintState = async (): Promise<string> =>
        signOAuthState(TEST_OAUTH_STATE_SECRET, {
          organisationId: seatOrg.id,
          userId: seatOrg.members[0]!.id,
          nonce: randomUUID(),
        });

      const [first, second] = await Promise.all([
        request(app.getHttpServer()).get(
          `/integrations/microsoft/callback?code=a&state=${await mintState()}`,
        ),
        request(app.getHttpServer()).get(
          `/integrations/microsoft/callback?code=b&state=${await mintState()}`,
        ),
      ]);

      const locations = [first.headers.location, second.headers.location];
      const refused = locations.filter((location) => location?.includes("seat_limit_reached"));
      const accepted = locations.filter((location) => location?.includes("connected=1"));
      expect(refused).toHaveLength(1);
      expect(accepted).toHaveLength(1);

      const live = await owner.emailAccount.count({
        where: { organisationId: seatOrg.id, deletedAt: null },
      });
      expect(live).toBe(2);
    });

    it("refuses to lower seats below the number of mailboxes in use, and says by how many", async () => {
      await clearMailboxes();
      await addMailbox("one@seats.example", true);
      await addMailbox("two@seats.example");

      const response = await request(app.getHttpServer())
        .put(`/organisations/${seatOrg.id}/modules/email_credit_controller`)
        .set("Authorization", `Bearer ${seatToken}`)
        .send({ enabled: true, seats: 1 })
        .expect(400);
      expect(response.body.message).toContain("disconnect 1");
    });

    it("disconnecting the primary promotes the oldest remaining, and audits it", async () => {
      await clearMailboxes();
      const primary = await addMailbox("one@seats.example", true);
      const successor = await addMailbox("two@seats.example");

      await request(app.getHttpServer())
        .post(`/organisations/${seatOrg.id}/mailboxes/${primary.id}/disconnect`)
        .set("Authorization", `Bearer ${seatToken}`)
        .expect(204);

      const promoted = await owner.emailAccount.findUniqueOrThrow({ where: { id: successor.id } });
      expect(promoted.isPrimary).toBe(true);
      await owner.auditLog.findFirstOrThrow({
        where: {
          organisationId: seatOrg.id,
          action: "mailbox.primary_changed",
          entityId: successor.id,
        },
      });
    });

    it("choosing a different primary moves it, and never leaves two", async () => {
      await clearMailboxes();
      const first = await addMailbox("one@seats.example", true);
      const second = await addMailbox("two@seats.example");

      await request(app.getHttpServer())
        .put(`/organisations/${seatOrg.id}/mailboxes/${second.id}/primary`)
        .set("Authorization", `Bearer ${seatToken}`)
        .expect(200);

      const primaries = await owner.emailAccount.findMany({
        where: { organisationId: seatOrg.id, deletedAt: null, isPrimary: true },
      });
      expect(primaries).toHaveLength(1);
      expect(primaries[0]!.id).toBe(second.id);
      expect(
        (await owner.emailAccount.findUniqueOrThrow({ where: { id: first.id } })).isPrimary,
      ).toBe(false);
    });
  });

  describe("POST .../mailboxes/connect", () => {
    it("403s for a member without mailbox:manage (finance is read-only)", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
    });

    it("404s for a non-member", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${otherOrg.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });

    it("200s with an authorize URL whose state binds this org + user (30-min JWT)", async () => {
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
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

  /**
   * Defect F1: `admin_consent_required` never fires, because Microsoft reports
   * the "Need admin approval" wall as an ordinary decline. The UI therefore has
   * to offer BOTH readings of a decline, and this endpoint supplies the
   * administrator half â€” the link the customer forwards to their IT contact.
   */
  describe("GET .../mailboxes/admin-consent (F1)", () => {
    const adminConsentUrl = (email?: string) =>
      `/organisations/${org.id}/mailboxes/admin-consent${email ? `?email=${encodeURIComponent(email)}` : ""}`;

    it("builds a TENANT-SPECIFIC link and names the customer's own organisation", async () => {
      discoveryStub.describeDomain.mockResolvedValueOnce({
        kind: "work",
        tenantId: "b6ae81d6-90c0-4114-a1a0-dc674c5900a9",
        organisationName: "Acme Ltd",
      });

      const response = await request(app.getHttpServer())
        .get(adminConsentUrl("sara@acme.example"))
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);

      const url = new URL(response.body.url);
      // The tenant-specific form renders the org-wide screen ("No one else will
      // be prompted"); `organizations` is only the fallback.
      expect(url.pathname).toBe("/b6ae81d6-90c0-4114-a1a0-dc674c5900a9/adminconsent");
      expect(url.origin).toBe("https://login.microsoftonline.com");
      expect(url.searchParams.get("client_id")).toBeTruthy();
      expect(response.body.organisationName).toBe("Acme Ltd");
      expect(response.body.accountKind).toBe("work");
      expect(discoveryStub.describeDomain).toHaveBeenCalledWith("acme.example");
    });

    it("carries a SEVEN-DAY admin_consent state, because the link gets forwarded", async () => {
      discoveryStub.describeDomain.mockResolvedValueOnce({
        kind: "work",
        tenantId: randomUUID(),
        organisationName: "Acme Ltd",
      });

      const response = await request(app.getHttpServer())
        .get(adminConsentUrl("sara@acme.example"))
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);

      const state = new URL(response.body.url).searchParams.get("state")!;
      const claims = await verifyOAuthState(TEST_OAUTH_STATE_SECRET, state, "admin_consent");
      expect(claims.organisationId).toBe(org.id);
      // A ten-minute token would expire before an IT contact ever opened it.
      await expect(verifyOAuthState(TEST_OAUTH_STATE_SECRET, state)).rejects.toThrow();
    });

    it("offers NO link for a personal account â€” there is no administrator to ask", async () => {
      discoveryStub.describeDomain.mockResolvedValueOnce({
        kind: "personal",
        tenantId: null,
        organisationName: null,
      });

      const response = await request(app.getHttpServer())
        .get(adminConsentUrl("sara@hotmail.co.uk"))
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);

      expect(response.body).toEqual({
        accountKind: "personal",
        url: null,
        organisationName: null,
      });
    });

    it("falls back to the generic form when the tenant is unknown", async () => {
      const response = await request(app.getHttpServer())
        .get(adminConsentUrl())
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);

      expect(new URL(response.body.url).pathname).toBe("/organizations/adminconsent");
      expect(response.body.accountKind).toBe("unknown");
    });

    it("403s for a member without mailbox:manage (finance)", async () => {
      await request(app.getHttpServer())
        .get(adminConsentUrl("sara@acme.example"))
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
    });

    it("404s for a non-member (cross-tenant is invisible, BRD 15)", async () => {
      await request(app.getHttpServer())
        .get(`/organisations/${otherOrg.id}/mailboxes/admin-consent`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });
  });

  describe("POST .../mailboxes/connect â€” login_hint (F5)", () => {
    it("passes the address to Microsoft and records it on the state", async () => {
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .send({ emailAddress: "sara@acme.example" })
        .expect(200);

      expect(graphStub.buildAuthorizeUrl).toHaveBeenCalledWith(expect.any(String), {
        loginHint: "sara@acme.example",
      });
      const state = new URL(response.body.authorizeUrl).searchParams.get("state")!;
      expect((await verifyOAuthState(TEST_OAUTH_STATE_SECRET, state)).loginHint).toBe(
        "sara@acme.example",
      );
    });

    it("rejects a malformed address rather than passing it to Microsoft", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .send({ emailAddress: "not-an-email" })
        .expect(400);
    });

    it("still works with no address at all", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
    });

    /** The seam between the web app and the callback: the flow has to reach the
     *  signed state here, or the round trip through Microsoft loses it and the
     *  customer is dropped on the settings page mid-setup. */
    it("carries the requested flow onto the signed state", async () => {
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .send({ emailAddress: "sara@acme.example", flow: "onboarding" })
        .expect(200);

      const state = new URL(response.body.authorizeUrl).searchParams.get("state")!;
      expect((await verifyOAuthState(TEST_OAUTH_STATE_SECRET, state)).flow).toBe("onboarding");
    });

    it("rejects a flow outside the known set rather than trusting the caller", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/connect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .send({ flow: "https://evil.example" })
        .expect(400);
    });
  });

  describe("GET /integrations/microsoft/callback (@Public)", () => {
    async function mintState(
      organisationId = org.id,
      extra: {
        purpose?: "connect" | "admin_consent";
        loginHint?: string;
        flow?: "onboarding" | "settings";
      } = {},
    ): Promise<string> {
      const ownerMember = org.members.find((member) => member.roleKey === "owner")!;
      return signOAuthState(TEST_OAUTH_STATE_SECRET, {
        organisationId,
        userId: ownerMember.id,
        nonce: randomUUID(),
        ...extra,
      });
    }

    /**
     * Defect F2: the /adminconsent return carries `admin_consent=True&tenant=`
     * with NO code and NO state of its own, and `state` used to be required â€”
     * so the customer's IT administrator finished approving Eva and landed on
     * `{"statusCode":400,"message":"Invalid request body â€” state: ..."}`.
     */
    describe("the /adminconsent return (F2)", () => {
      it("does NOT 400 when Microsoft sends admin_consent with no state at all", async () => {
        const response = await request(app.getHttpServer())
          .get("/integrations/microsoft/callback?admin_consent=True&tenant=" + randomUUID())
          .expect(302);

        expect(response.headers.location).toBe("http://localhost:3000/microsoft-approved");
      });

      /**
       * The approver is the customer's IT contact following a forwarded link,
       * with no Eva account. Every `/app/...` destination is behind the sign-in
       * proxy, which strips the query string on the way to `/sign-in` â€” so the
       * confirmation was discarded and the one person the journey depends on
       * saw a login form instead. The receipt must live outside `/app`.
       */
      it("lands the administrator on a page that does NOT require an Eva account", async () => {
        const response = await request(app.getHttpServer())
          .get(
            `/integrations/microsoft/callback?admin_consent=True&state=${await mintState(org.id, { purpose: "admin_consent" })}`,
          )
          .expect(302);

        expect(response.headers.location).not.toContain("/app/");
        expect(response.headers.location).toBe("http://localhost:3000/microsoft-approved");
      });

      it("attributes and audits the approval when our state came back", async () => {
        const tenantId = randomUUID();
        const state = await mintState(org.id, { purpose: "admin_consent" });

        const response = await request(app.getHttpServer())
          .get(
            `/integrations/microsoft/callback?admin_consent=True&tenant=${tenantId}&state=${state}`,
          )
          .expect(302);

        expect(response.headers.location).toBe("http://localhost:3000/microsoft-approved");
        const audit = await owner.auditLog.findFirst({
          where: { organisationId: org.id, action: "mailbox.admin_consent_granted" },
          orderBy: { createdAt: "desc" },
        });
        expect(audit).not.toBeNull();
        expect(audit?.metadata).toMatchObject({ tenant: tenantId });
      });

      /**
       * The admin-consent token lives seven days; the connect token is the
       * short-lived CSRF defence, and purpose-scoping is what makes the long
       * life affordable.
       *
       * What that scoping protects is ATTRIBUTION, not the page. Microsoft has
       * already granted the consent by the time we are called, so refusing to
       * confirm it would be false — and would strand an administrator whose
       * link simply aged past seven days. The property worth asserting is that
       * no organisation gets credited with an approval on the strength of a
       * borrowed state, so that is what this asserts.
       */
      it("shows the receipt for a CONNECT state but credits NO organisation", async () => {
        const before = await owner.auditLog.count({
          where: { organisationId: org.id, action: "mailbox.admin_consent_granted" },
        });

        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?admin_consent=True&state=${await mintState()}`)
          .expect(302);

        expect(response.headers.location).toBe("http://localhost:3000/microsoft-approved");
        const after = await owner.auditLog.count({
          where: { organisationId: org.id, action: "mailbox.admin_consent_granted" },
        });
        expect(after).toBe(before);
      });

      it("shows the receipt for a forged state, and still credits no organisation", async () => {
        const before = await owner.auditLog.count({
          where: { action: "mailbox.admin_consent_granted" },
        });

        const response = await request(app.getHttpServer())
          .get("/integrations/microsoft/callback?admin_consent=True&state=forged")
          .expect(302);

        expect(response.headers.location).toBe("http://localhost:3000/microsoft-approved");
        const after = await owner.auditLog.count({
          where: { action: "mailbox.admin_consent_granted" },
        });
        expect(after).toBe(before);
      });

      it("refuses an ADMIN_CONSENT state when completing a connect", async () => {
        const state = await mintState(org.id, { purpose: "admin_consent" });

        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?code=fake&state=${state}`)
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/settings/mailbox?error=invalid_state",
        );
        expect(graphStub.exchangeCode).not.toHaveBeenCalled();
      });

      it("still REDIRECTS for a callback carrying nothing at all", async () => {
        // The whole point of F2 is that this route owes the browser a redirect
        // in every case. Tightening the schema to reject unrecognised shapes
        // would reintroduce the raw-JSON 400 by a different door.
        const response = await request(app.getHttpServer())
          .get("/integrations/microsoft/callback")
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/settings/mailbox?error=invalid_state",
        );
      });
    });

    it("carries the attempted address through a decline, so the UI can name it (F1)", async () => {
      const state = await mintState(org.id, { loginHint: "sara@acme.example" });

      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?error=access_denied&state=${state}`)
        .expect(302);

      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=consent_denied&hint=sara%40acme.example",
      );
    });

    it("redirects ?error=consent_denied when Microsoft returns an error", async () => {
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?error=access_denied&state=${await mintState()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=consent_denied",
      );
    });

    /** Microsoft's DEFAULT consent policy blocks Mail scopes for an unverified
     *  publisher, so most real customers meet the "Approval required" screen â€”
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

    /**
     * Defect F3: an account with no Exchange licence used to be stored as a
     * healthy connection and only failed at the first send â€” reported as
     * "authorisation expired", advice that can never work. Catch it while the
     * user is still watching, and store nothing.
     */
    it("redirects ?error=mailbox_unavailable and stores NOTHING for an account with no mailbox", async () => {
      graphStub.probeMailbox.mockRejectedValueOnce(new MailboxUnavailableError());
      // Counted rather than compared to []: earlier specs in this describe
      // leave live and soft-deleted rows on the same org, and the property
      // under test is "this call wrote nothing", not "the table is empty".
      const before = await owner.emailAccount.count({ where: { organisationId: org.id } });

      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
        .expect(302);

      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?error=mailbox_unavailable",
      );
      const after = await owner.emailAccount.count({ where: { organisationId: org.id } });
      expect(after).toBe(before);
    });

    it("probes every connect, so a dead mailbox cannot be stored unchecked", async () => {
      await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
        .expect(302);

      expect(graphStub.probeMailbox).toHaveBeenCalledTimes(1);
      expect(graphStub.probeMailbox).toHaveBeenCalledWith(DEFAULT_TOKENS.accessToken);
    });

    it("happy path: 302 ?connected=1, row upserted with CIPHERTEXT tokens, audit written", async () => {
      // Precondition stated rather than inherited: specs in this file share an
      // organisation, so whether this callback INSERTs or UPDATEs used to
      // depend on execution order — and it now decides whether the test email
      // fires. Start disconnected so this is unambiguously a NEW connection.
      await owner.emailAccount.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const response = await request(app.getHttpServer())
        .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
        .expect(302);
      expect(response.headers.location).toBe(
        "http://localhost:3000/app/settings/mailbox?connected=1&test_email=sent",
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
      // Matched on the account id rather than "the first mailbox.connected row
      // for this org". Specs here share an organisation, so the loose query
      // returned whichever row happened to be first and only agreed with
      // `account.id` while every connect in the file reused one row — an
      // assertion that held by coincidence, not because the audit was right.
      const audit = await owner.auditLog.findFirst({
        where: { organisationId: org.id, action: "mailbox.connected", entityId: account.id },
      });
      expect(audit).not.toBeNull();
    });

    /**
     * The state is valid for 30 minutes and ruling 4 binds it to an
     * ORGANISATION, not a role â€” so the initiator can lose mailbox:manage
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

    /**
     * The founder's journey ends with proof that sending works, not with a
     * question (ruling 2026-07-31: send it, say so, move on). `probeMailbox`
     * only proves the account can READ mail — a restricted sender, a shared
     * mailbox or a half-revoked grant all read fine and fail to send — so
     * without this the first proof that sending works would be a real chasing
     * email to a real customer.
     */
    describe("the test email on first connect", () => {
      async function startDisconnected(): Promise<void> {
        await owner.emailAccount.updateMany({
          where: { organisationId: org.id, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }

      it("sends a self-addressed test email and records it", async () => {
        await startDisconnected();
        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/settings/mailbox?connected=1&test_email=sent",
        );
        expect(graphStub.sendMail).toHaveBeenCalledTimes(1);
        expect(graphStub.sendMail).toHaveBeenCalledWith(
          DEFAULT_TOKENS.accessToken,
          expect.objectContaining({ to: SANDBOX_EMAIL }),
        );
        const account = await owner.emailAccount.findFirstOrThrow({
          where: { organisationId: org.id, deletedAt: null },
        });
        expect(account.lastHealthCheckAt).not.toBeNull();
        const audit = await owner.auditLog.findFirst({
          where: { organisationId: org.id, action: "mailbox.test_email_sent" },
          orderBy: { createdAt: "desc" },
        });
        expect(audit?.entityId).toBe(account.id);
      });

      /** A reconnect is someone repairing a broken grant on the settings page,
       *  not someone signing up. Posting them an email they did not ask for is
       *  noise, so the live row must suppress the send. */
      it("does NOT send again when an existing live connection is replaced", async () => {
        await insertConnectedMailbox(owner, org.id);
        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/settings/mailbox?connected=1",
        );
        expect(graphStub.sendMail).not.toHaveBeenCalled();
      });

      /**
       * The mailbox is connected and COMMITTED before the send is attempted, so
       * a failed test send is not a failed connection and must never be
       * reported as one — that would send the customer back to reconnect a
       * mailbox that is already fine.
       */
      it("still reports the connection as successful when the test email fails", async () => {
        await startDisconnected();
        graphStub.sendMail.mockRejectedValueOnce(new GraphRequestError("nope", 500));

        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?code=fake&state=${await mintState()}`)
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/settings/mailbox?connected=1&test_email=failed",
        );
        const account = await owner.emailAccount.findFirstOrThrow({
          where: { organisationId: org.id, deletedAt: null },
        });
        // Read access was just proven by probeMailbox, so one failed send must
        // not paint a red error across a mailbox that works.
        expect(account.healthStatus).toBe("active");
        expect(account.lastError).toBeNull();
      });
    });

    /**
     * The flow rides the signed state because the browser is at Microsoft in
     * between — nothing we hold locally survives the round trip. It is an enum
     * mapped to a path server-side, never a URL, so a leaked state cannot be
     * turned into an open redirect.
     */
    describe("returning to the screen the connection started from", () => {
      it("sends a connection started in onboarding back to the setup flow", async () => {
        await owner.emailAccount.updateMany({
          where: { organisationId: org.id, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        const response = await request(app.getHttpServer())
          .get(
            `/integrations/microsoft/callback?code=fake&state=${await mintState(org.id, { flow: "onboarding" })}`,
          )
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/onboarding?connected=1&test_email=sent",
        );
      });

      /** The decline path resolves the flow BEFORE the state is verified for
       *  real, so it needs its own proof that it lands in the right place. */
      it("sends a decline during onboarding back to the setup flow", async () => {
        const state = await mintState(org.id, {
          flow: "onboarding",
          loginHint: "sara@acme.example",
        });
        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?error=access_denied&state=${state}`)
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/onboarding?error=consent_denied&hint=sara%40acme.example",
        );
      });

      it("falls back to the settings page for a state that names no flow", async () => {
        const response = await request(app.getHttpServer())
          .get(`/integrations/microsoft/callback?error=access_denied&state=${await mintState()}`)
          .expect(302);

        expect(response.headers.location).toBe(
          "http://localhost:3000/app/settings/mailbox?error=consent_denied",
        );
      });
    });

    it("reconnecting the SAME address reuses its row and consumes no second seat", async () => {
      // Was "reconnect replaces the single live connection (ruling 6)". The
      // assertion is unchanged and still exactly right, but the reason is
      // different now: one live row per ADDRESS, not one per organisation.
      // Start disconnected so the first callback INSERTs and the second
      // UPDATEs — a soft-deleted row must block neither.
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

  describe("POST .../mailboxes/:mailboxId/disconnect", () => {
    it("wipes tokens + soft-deletes in one transaction, audited (ruling 8)", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/disconnect`)
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

    it("404s for a mailbox id that is not connected", async () => {
      // Slice 1.6a: the route names a mailbox, so "nothing is connected" is no
      // longer the shape of this failure — an unknown id is.
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${randomUUID()}/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });

    it("403s for finance (read-only), 404s cross-tenant", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
      // Another organisation's mailbox is invisible, not forbidden: RLS filters
      // the row out entirely, so 404 is what the query genuinely returns.
      await request(app.getHttpServer())
        .post(`/organisations/${otherOrg.id}/mailboxes/${account.id}/disconnect`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
    });
  });

  describe("POST .../mailboxes/:mailboxId/test-email (self-addressed, ruling 7)", () => {
    it("sends with the stored token, stamps health, audits", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
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
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
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

    it("invalid_grant on refresh â†’ 400 + health stamped auth_expired", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      graphStub.refreshTokens.mockRejectedValueOnce(new ReauthRequiredError());
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);
      expect(response.body.message).toContain("reconnect");
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.healthStatus).toBe("auth_expired");
      expect(after.lastError).toContain("reconnect");
      // A failed attempt is still an attempt, and the transition is a tenant
      // mutation like any other â€” it must be timestamped and audited, or
      // "when did this mailbox die?" is unanswerable.
      expect(after.lastHealthCheckAt).not.toBeNull();
      await owner.auditLog.findFirstOrThrow({
        where: { organisationId: org.id, action: "mailbox.auth_expired", entityId: account.id },
      });
    });

    /**
     * TOKEN_ENCRYPTION_KEY rotation is an explicitly supported future operation
     * (that is why the ciphertext carries a `v1` prefix), and plan Â§8 risk 3
     * names key mishandling. Undecryptable stored tokens must present as a dead
     * grant â€” otherwise the caller gets an opaque 500 while the settings card
     * still says "Connected", and 1.7's sender fails forever with no signal.
     */
    it("undecryptable stored tokens are treated as a dead grant, not a 500", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        accessTokenEncrypted: encryptToken("token-under-a-different-key", OTHER_TOKEN_KEY),
      });
      const response = await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);
      expect(response.body.message).toContain("reconnect");
      expect(graphStub.sendMail).not.toHaveBeenCalled();
      const after = await owner.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(after.healthStatus).toBe("auth_expired");
    });

    it("Graph failure â†’ 502", async () => {
      const account = await insertConnectedMailbox(owner, org.id);
      graphStub.sendMail.mockRejectedValueOnce(new GraphRequestError("nope", 500));
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(502);
    });

    /**
     * The reason the send path is four committed steps rather than one
     * transaction (founder ruling 2026-07-30): Microsoft rotates the refresh
     * token when it is redeemed, so a rotation must NEVER be undone by a later
     * failure. Here the refresh succeeds and the send then fails â€” the stored
     * pair must still be the new one. One transaction would roll it back and
     * leave us holding a pair Microsoft has moved past.
     */
    it("keeps a rotated token pair after a later send failure (no rollback of the refresh)", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      graphStub.sendMail.mockRejectedValueOnce(new GraphRequestError("nope", 500));
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
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

    it("404s for an unknown mailbox id; 403s for finance", async () => {
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${randomUUID()}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(404);
      const account = await insertConnectedMailbox(owner, org.id);
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("finance")}`)
        .expect(403);
    });

    /** The list endpoint is how the UI learns a reconnect is needed
     *  (ruling 10) â€” prove the auth_expired stamp actually surfaces. */
    it("surfaces auth_expired through the list endpoint after a dead grant", async () => {
      const account = await insertConnectedMailbox(owner, org.id, {
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      graphStub.refreshTokens.mockRejectedValueOnce(new ReauthRequiredError());
      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${account.id}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);
      const status = await request(app.getHttpServer())
        .get(`/organisations/${org.id}/mailboxes`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(200);
      const listed = status.body.mailboxes.find((row: { id: string }) => row.id === account.id);
      expect(listed.healthStatus).toBe("auth_expired");
      expect(listed.lastError).toContain("reconnect");
      expect(JSON.stringify(status.body)).not.toContain("fixture-refresh-token");
    });

    /**
     * THE defect seats introduce, and it is silent (slice 1.6a Task 7c).
     *
     * `markUnhealthy` used to re-find "the" live mailbox rather than taking an
     * id. With one mailbox that was harmless. With two, a failure on mailbox B
     * could mark mailbox A dead instead — a healthy mailbox stops sending
     * while the broken one still reads "Connected", and nothing tells anyone.
     */
    it("marks the mailbox that actually failed, and no other", async () => {
      await owner.emailAccount.updateMany({
        where: { organisationId: org.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const healthy = await owner.emailAccount.create({
        data: {
          organisationId: org.id,
          provider: "microsoft",
          emailAddress: `healthy-${randomUUID().slice(0, 8)}@example.com`,
          accessTokenEncrypted: encryptToken("fixture-access-token", TEST_TOKEN_ENCRYPTION_KEY),
          refreshTokenEncrypted: encryptToken("fixture-refresh-token", TEST_TOKEN_ENCRYPTION_KEY),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["Mail.Send"],
          healthStatus: "active",
          isPrimary: true,
        },
      });
      const broken = await owner.emailAccount.create({
        data: {
          organisationId: org.id,
          provider: "microsoft",
          emailAddress: `broken-${randomUUID().slice(0, 8)}@example.com`,
          accessTokenEncrypted: encryptToken("fixture-access-token", TEST_TOKEN_ENCRYPTION_KEY),
          refreshTokenEncrypted: encryptToken("fixture-refresh-token", TEST_TOKEN_ENCRYPTION_KEY),
          // Expired, so the send path refreshes — and the refresh is what fails.
          tokenExpiresAt: new Date(Date.now() - 60_000),
          scopes: ["Mail.Send"],
          healthStatus: "active",
        },
      });
      graphStub.refreshTokens.mockRejectedValueOnce(new ReauthRequiredError());

      await request(app.getHttpServer())
        .post(`/organisations/${org.id}/mailboxes/${broken.id}/test-email`)
        .set("Authorization", `Bearer ${tokenFor("owner")}`)
        .expect(400);

      expect(
        (await owner.emailAccount.findUniqueOrThrow({ where: { id: broken.id } })).healthStatus,
      ).toBe("auth_expired");
      // The one that did nothing wrong must be untouched.
      const other = await owner.emailAccount.findUniqueOrThrow({ where: { id: healthy.id } });
      expect(other.healthStatus).toBe("active");
      expect(other.lastError).toBeNull();
    });
  });
});
