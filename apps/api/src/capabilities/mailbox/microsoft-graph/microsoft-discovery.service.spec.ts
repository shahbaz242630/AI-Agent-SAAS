import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrosoftDiscoveryService } from "./microsoft-discovery.service.js";

/**
 * Fixtures are the REAL responses observed on 2026-07-31 (spike recorded in
 * docs/ONBOARDING-IMPLEMENTATION-PLAN.md Task 2). That matters more than usual
 * here: defect F1 shipped with passing tests precisely because they asserted
 * an input Microsoft does not send.
 */

const REALM = {
  work: {
    NameSpaceType: "Federated",
    DomainName: "onestepfixit.com",
    FederationBrandName: "onestepfixit.com",
  },
  managed: {
    NameSpaceType: "Managed",
    DomainName: "evacrosstenanttest.onmicrosoft.com",
    FederationBrandName: "Eva Cross Tenant Test",
  },
  personal: {
    NameSpaceType: "Federated",
    DomainName: "live.com",
    FederationBrandName: "Windows Live",
  },
  unknown: { NameSpaceType: "Unknown" },
};

const ISSUER = (guid: string) => ({ issuer: `https://login.microsoftonline.com/${guid}/v2.0` });

function stubMicrosoft(routes: { realm?: unknown; openid?: unknown; status?: number }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);
      const body = url.includes("/userrealm/") ? routes.realm : routes.openid;
      if (body === undefined) return Promise.resolve(new Response(null, { status: 400 }));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: routes.status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("MicrosoftDiscoveryService", () => {
  it("classifies a work tenant and recovers its GUID and name", async () => {
    stubMicrosoft({
      realm: REALM.managed,
      openid: ISSUER("f1e57f4b-cbb7-431c-83c8-0b2450ac055a"),
    });

    expect(
      await new MicrosoftDiscoveryService().describeDomain("evacrosstenanttest.onmicrosoft.com"),
    ).toEqual({
      kind: "work",
      tenantId: "f1e57f4b-cbb7-431c-83c8-0b2450ac055a",
      organisationName: "Eva Cross Tenant Test",
    });
  });

  it("classifies a work tenant that reports Federated rather than Managed", async () => {
    // onestepfixit.com really does answer "Federated" — so NameSpaceType alone
    // cannot separate business from personal, which is the trap this exists for.
    stubMicrosoft({ realm: REALM.work, openid: ISSUER("b6ae81d6-90c0-4114-a1a0-dc674c5900a9") });

    const result = await new MicrosoftDiscoveryService().describeDomain("onestepfixit.com");

    expect(result.kind).toBe("work");
    expect(result.tenantId).toBe("b6ae81d6-90c0-4114-a1a0-dc674c5900a9");
  });

  it("classifies a personal Microsoft account and never claims it has an admin", async () => {
    stubMicrosoft({
      realm: REALM.personal,
      openid: ISSUER("9cd80435-793b-4f48-844b-6b3f37d1c1f3"),
    });

    const result = await new MicrosoftDiscoveryService().describeDomain("hotmail.co.uk");

    expect(result.kind).toBe("personal");
    // A consumer domain HAS a tenant GUID, and using it would build an
    // admin-consent link for an organisation that does not exist.
    expect(result.tenantId).toBeNull();
  });

  it("treats an address-shaped Microsoft account on a third-party domain as personal", async () => {
    // x@gmail.com really answers live.com — a Microsoft account can be
    // registered against any address.
    stubMicrosoft({ realm: REALM.personal });

    expect((await new MicrosoftDiscoveryService().describeDomain("gmail.com")).kind).toBe(
      "personal",
    );
  });

  it("reports unknown for a domain Microsoft has never heard of", async () => {
    stubMicrosoft({ realm: REALM.unknown });

    expect(
      await new MicrosoftDiscoveryService().describeDomain("not-a-real-domain-xyz.com"),
    ).toEqual({ kind: "unknown", tenantId: null, organisationName: null });
  });

  it("stays 'work' when the tenant GUID cannot be read", async () => {
    stubMicrosoft({ realm: REALM.managed, openid: { issuer: "not-a-url" } });

    const result = await new MicrosoftDiscoveryService().describeDomain("acme.example");

    expect(result.kind).toBe("work");
    expect(result.tenantId).toBeNull(); // falls back to the generic consent form
  });

  it("sends a placeholder local part, never a real address", async () => {
    stubMicrosoft({ realm: REALM.personal });

    await new MicrosoftDiscoveryService().describeDomain("hotmail.co.uk");

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const realmUrl = String(calls[0]?.[0]);
    expect(realmUrl).toContain("hotmail.co.uk");
    expect(realmUrl).not.toContain("sara");
  });

  it("fails OPEN — a Microsoft outage must never block a connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(new MicrosoftDiscoveryService().describeDomain("acme.example")).resolves.toEqual({
      kind: "unknown",
      tenantId: null,
      organisationName: null,
    });
  });

  it("rejects a malformed domain without calling Microsoft at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of ["", "no-dot", "sara@acme.com", "-acme.com", "a".repeat(300) + ".com"]) {
      expect((await new MicrosoftDiscoveryService().describeDomain(bad)).kind).toBe("unknown");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches, so a retry loop cannot hammer Microsoft", async () => {
    stubMicrosoft({ realm: REALM.personal });
    const service = new MicrosoftDiscoveryService();

    await service.describeDomain("hotmail.co.uk");
    await service.describeDomain("HOTMAIL.CO.UK");

    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});
