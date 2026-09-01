import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { InvalidOAuthStateError, signOAuthState, verifyOAuthState } from "./oauth-state.js";

const SECRET = "test-oauth-state-secret-0123456789abcdef"; // gitleaks:allow — fake test fixture
const CLAIMS = {
  organisationId: "8b043d9f-c730-4274-90a7-ec3322e8a827",
  userId: "cc07bfd6-d514-4e4d-9fa9-1674b3958b73",
  nonce: "n-1",
  // Which product the mailbox is for (slice 3.1c-0). Mandatory on a CONNECT
  // state — see the two tests at the end of this file for why it refuses
  // rather than degrading like `flow` and `replacesMailboxId` do.
  moduleKey: "email_credit_controller" as const,
};

describe("OAuth state JWT (Slice 1.6, ruling 4)", () => {
  it("round-trips the claims, defaulting to the connect purpose", async () => {
    const state = await signOAuthState(SECRET, CLAIMS);
    await expect(verifyOAuthState(SECRET, state)).resolves.toEqual({
      ...CLAIMS,
      purpose: "connect",
    });
  });

  it("round-trips the login hint when one was given", async () => {
    const state = await signOAuthState(SECRET, { ...CLAIMS, loginHint: "sara@acme.example" });
    await expect(verifyOAuthState(SECRET, state)).resolves.toMatchObject({
      loginHint: "sara@acme.example",
    });
  });

  /**
   * The flow decides where the callback sends the browser back to. It survives
   * the round trip only because it is signed into the state — the browser is at
   * Microsoft in between, so nothing we hold locally comes back with it.
   */
  describe("return flow", () => {
    it("round-trips the flow when one was given", async () => {
      const state = await signOAuthState(SECRET, { ...CLAIMS, flow: "onboarding" });
      await expect(verifyOAuthState(SECRET, state)).resolves.toMatchObject({
        flow: "onboarding",
      });
    });

    it("omits the flow entirely when none was given, so readers apply their own default", async () => {
      const state = await signOAuthState(SECRET, CLAIMS);
      await expect(verifyOAuthState(SECRET, state)).resolves.not.toHaveProperty("flow");
    });

    /**
     * DROPPED, not rejected. The signature has already proved we minted this
     * token, so a value outside the enum means our own code changed — refusing
     * it would strand a connection mid-flight across a deploy for no safety
     * gain. The reader falls back to the settings page, which is somewhere real.
     */
    it("drops an unrecognised flow rather than failing the whole state", async () => {
      const state = await new SignJWT({
        ...CLAIMS,
        purpose: "connect",
        flow: "https://evil.example",
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(SECRET));
      const claims = await verifyOAuthState(SECRET, state);
      expect(claims).not.toHaveProperty("flow");
      expect(claims.organisationId).toBe(CLAIMS.organisationId);
    });
  });

  /**
   * The admin-consent token lives SEVEN DAYS, because the approval link gets
   * forwarded to an IT contact who opens it whenever they get to it. That is
   * only affordable because the two purposes are not interchangeable — asserted
   * in both directions, since the long-lived one is the dangerous one.
   */
  describe("purpose scoping", () => {
    it("refuses an admin_consent token where a connect token is expected", async () => {
      const state = await signOAuthState(SECRET, { ...CLAIMS, purpose: "admin_consent" });
      await expect(verifyOAuthState(SECRET, state)).rejects.toBeInstanceOf(InvalidOAuthStateError);
    });

    it("refuses a connect token where an admin_consent token is expected", async () => {
      const state = await signOAuthState(SECRET, CLAIMS);
      await expect(verifyOAuthState(SECRET, state, "admin_consent")).rejects.toBeInstanceOf(
        InvalidOAuthStateError,
      );
    });

    it("accepts an admin_consent token for its own purpose", async () => {
      const state = await signOAuthState(SECRET, { ...CLAIMS, purpose: "admin_consent" });
      await expect(verifyOAuthState(SECRET, state, "admin_consent")).resolves.toMatchObject({
        purpose: "admin_consent",
        organisationId: CLAIMS.organisationId,
      });
    });

    it("reads a token with no purpose claim as connect, for tokens in flight across a deploy", async () => {
      const legacy = await new SignJWT(CLAIMS)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(SECRET));
      await expect(verifyOAuthState(SECRET, legacy)).resolves.toMatchObject({
        purpose: "connect",
      });
    });
  });

  it("rejects a state signed with a different secret", async () => {
    const state = await signOAuthState("another-secret-0123456789abcdef012345", CLAIMS);
    await expect(verifyOAuthState(SECRET, state)).rejects.toBeInstanceOf(InvalidOAuthStateError);
  });

  it("rejects an expired state", async () => {
    const expired = await new SignJWT(CLAIMS)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 900)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyOAuthState(SECRET, expired)).rejects.toBeInstanceOf(InvalidOAuthStateError);
  });

  it("rejects garbage", async () => {
    await expect(verifyOAuthState(SECRET, "not-a-jwt")).rejects.toBeInstanceOf(
      InvalidOAuthStateError,
    );
  });

  /** Correctly signed but malformed claims must not reach withTenant as the
   *  literal "undefined" / a non-uuid — that surfaces as a 500 on the ::uuid
   *  cast instead of the callback's clean ?error=invalid_state redirect. */
  it.each([
    ["a missing organisationId", { userId: CLAIMS.userId, nonce: "n-1" }],
    ["a non-uuid organisationId", { ...CLAIMS, organisationId: "not-a-uuid" }],
    ["a missing userId", { organisationId: CLAIMS.organisationId, nonce: "n-1" }],
    ["a missing nonce", { organisationId: CLAIMS.organisationId, userId: CLAIMS.userId }],
  ])("rejects a validly-signed state with %s", async (_label, claims) => {
    const state = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyOAuthState(SECRET, state)).rejects.toBeInstanceOf(InvalidOAuthStateError);
  });

  /**
   * Which product a mailbox is for (slice 3.1c-0, ruling 36).
   *
   * ⚠️ THIS IS THE ONE CLAIM THAT REFUSES RATHER THAN DEGRADES, and the pair
   * below is the whole argument. `flow` and `replacesMailboxId` both fall back
   * to something harmless when unreadable — a real screen, or a plain connect.
   * There is no harmless fallback for the product: guessing files the mailbox
   * against one the customer never chose, bills its seat, and looks entirely
   * successful on every screen.
   */
  describe("the product a connect is for", () => {
    const unsigned = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(SECRET));

    it("refuses a connect state that names no product", async () => {
      const { moduleKey: _dropped, ...withoutProduct } = CLAIMS;
      await expect(verifyOAuthState(SECRET, await unsigned(withoutProduct))).rejects.toBeInstanceOf(
        InvalidOAuthStateError,
      );
    });

    it("refuses a connect state naming a product that does not exist", async () => {
      const state = await unsigned({ ...CLAIMS, moduleKey: "no_such_product" });
      await expect(verifyOAuthState(SECRET, state)).rejects.toBeInstanceOf(InvalidOAuthStateError);
    });

    /**
     * ⚠️ AND ADMIN CONSENT NEEDS NONE, WHICH IS THE MODEL RATHER THAN AN
     * OVERSIGHT. It is one Microsoft TENANT approving the Eva app; it connects
     * no mailbox and belongs to no product, so demanding one would invent a
     * fact. Asserted so a later "tidy-up" cannot make it mandatory everywhere.
     */
    it("accepts an admin_consent state with no product at all", async () => {
      const { moduleKey: _dropped, ...withoutProduct } = CLAIMS;
      const state = await signOAuthState(SECRET, {
        ...withoutProduct,
        purpose: "admin_consent",
      });
      await expect(verifyOAuthState(SECRET, state, "admin_consent")).resolves.toMatchObject({
        purpose: "admin_consent",
      });
    });
  });
});
