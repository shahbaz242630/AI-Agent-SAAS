import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvaPrismaClient } from "@eva/database";
import {
  createOrgWithMembers,
  createOwnerClient,
  createTestApp,
  seedTestDatabase,
  signToken,
  type FixtureOrg,
} from "./support.js";

/**
 * Connecting a Gmail mailbox (Slice 3.1b, step 3).
 *
 * ⚠️ THE PRODUCT WE ALREADY SELL WAS MICROSOFT-ONLY AND NOBODY HAD SAID SO OUT
 * LOUD. Eva sends from the customer's own mailbox, and until migration 0030 the
 * only mailbox the database would accept was Microsoft — so a sole trader on
 * Gmail could not use Invoice Chasing either. For a platform aimed at
 * freelancers that was exactly the wrong way round.
 *
 * These tests are about the SEAM rather than about Google: that the choice
 * reaches the right adapter, that the old callers keep working untouched, and
 * that an environment without credentials refuses honestly instead of sending
 * somebody to a broken Google page.
 */
describe("Connecting a Gmail mailbox", () => {
  let app: INestApplication;
  let owner: EvaPrismaClient;
  let org: FixtureOrg;
  let token: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    await seedTestDatabase(owner);
    app = await createTestApp();
    org = await createOrgWithMembers(owner, "gmail-connect", ["owner"], "Halloway Roofing", [
      { moduleKey: "email_credit_controller", seats: 5 },
    ]);
    token = await signToken({
      sub: org.members[0]!.authUserId,
      email: org.members[0]!.email,
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  const connect = (body: Record<string, unknown>, on: INestApplication = app) =>
    request(on.getHttpServer())
      .post(`/organisations/${org.id}/mailboxes/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  it("sends the customer to Google when they choose Gmail", async () => {
    const response = await connect({ provider: "google" }).expect(200);
    const url = new URL(response.body.authorizeUrl);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    // The two parameters without which a reconnect silently yields no refresh
    // token — see gmail-provider.spec.ts for why that is fatal.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
  });

  /**
   * ⚠️ THE OLD CALLERS MUST NOT NOTICE. The settings screen and onboarding both
   * posted this endpoint with no provider for months. Making the field required
   * would have 400'd every one of them — and the breakage would land on the
   * product that already has customers, to ship one that does not.
   */
  it("still goes to Microsoft when no provider is named at all", async () => {
    const response = await connect({}).expect(200);
    expect(response.body.authorizeUrl).toContain("login.microsoftonline.com");
  });

  it("goes to Microsoft when Microsoft is asked for explicitly", async () => {
    const response = await connect({ provider: "microsoft" }).expect(200);
    expect(response.body.authorizeUrl).toContain("login.microsoftonline.com");
  });

  it("refuses a provider that is not one of the two", async () => {
    await connect({ provider: "carrier-pigeon" }).expect(400);
  });

  /**
   * ⚠️ REFUSED, NOT ATTEMPTED. Without a client id we would build an authorize
   * URL with an empty one and send the customer to a Google error page they
   * cannot act on — having just told them Eva supports Gmail. Optional at boot
   * so the API still starts anywhere; refused at the moment it is needed.
   */
  it("says Gmail is not configured rather than sending them to a broken Google page", async () => {
    const unconfigured = await createTestApp({ env: { GOOGLE_CLIENT_ID: "" } });
    try {
      const response = await connect({ provider: "google" }, unconfigured).expect(400);
      expect(JSON.stringify(response.body)).toContain("not configured");

      // Microsoft is untouched by Google being unconfigured.
      await connect({ provider: "microsoft" }, unconfigured).expect(200);
    } finally {
      await unconfigured.close();
    }
  });

  /**
   * ⚠️ ITS OWN ROUTE, BECAUSE A REDIRECT URI IS REGISTERED WITH THE PROVIDER IN
   * ADVANCE AND EXACTLY. Sharing one path would mean guessing which provider
   * had replied from a query string the provider controls. The path is the
   * answer and cannot be spoofed into being the other one.
   */
  it("has a Google callback that is separate from Microsoft's", async () => {
    const response = await request(app.getHttpServer())
      .get("/integrations/google/callback")
      .query({ error: "access_denied" })
      .expect(302);
    expect(response.headers.location).toContain("error=");
    /**
     * ⚠️ AND IT SAYS SO IS GOOGLE'S. Founder ruling 2026-08-22 — separate
     * paths, no crossing. Without this the web falls back to Microsoft and a
     * Gmail customer who cancelled is told to ask their Microsoft 365
     * administrator for approval, which is the defect the ruling names.
     *
     * The Microsoft half of the same guarantee is in `mailboxes.spec.ts`; this
     * is the side that was actually getting it wrong.
     */
    expect(new URL(String(response.headers.location)).searchParams.get("provider")).toBe("google");

    // And Microsoft's is still where it was — the 3.0 handoff is explicit that
    // its registered URI must not move.
    await request(app.getHttpServer())
      .get("/integrations/microsoft/callback")
      .query({ error: "access_denied" })
      .expect(302);
  });
});
