import { Injectable } from "@nestjs/common";
import type { DomainDiscovery, MicrosoftDiscovery } from "./microsoft-discovery.js";
import { UNKNOWN_DOMAIN } from "./microsoft-discovery.js";

/**
 * Two unauthenticated Microsoft endpoints, verified against seven real inputs
 * on 2026-07-31 (both tenants we own returned exactly the right GUID).
 *
 * The classifier is `/common/userrealm`. Note carefully that `NameSpaceType` is
 * NOT the discriminator — a business tenant and a personal account both answer
 * "Federated". The signal is `DomainName`: personal Microsoft accounts, whatever
 * the address, resolve to `live.com` / "Windows Live".
 *
 * The tenant GUID comes from the OpenID discovery document, and is fetched ONLY
 * once a domain is already known to be a work/school tenant. Consumer domains
 * have GUIDs too — `hotmail.co.uk` and `outlook.com` each return a different
 * one, and neither is the well-known consumer tenant — so classifying on the
 * GUID would label every sole trader a business.
 */

const LOGIN_BASE = "https://login.microsoftonline.com";
/** Personal Microsoft accounts all land here regardless of their address. */
const CONSUMER_REALM = "live.com";
/**
 * The local part is irrelevant to the answer — `nobody@` and `admin@` returned
 * identical realms for the same domain — so we send a placeholder and the
 * user's actual address never leaves Eva at this step.
 */
const PLACEHOLDER_LOCAL_PART = "eva-discovery";
/** Microsoft is not on the critical path: a slow answer is no answer. */
const TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Bounded so a stream of junk domains cannot grow the process's memory. */
const CACHE_MAX_ENTRIES = 500;
/** Labels 1-63 chars, at least one dot, no leading/trailing hyphen. */
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const MAX_DOMAIN_LENGTH = 253;

interface UserRealmResponse {
  NameSpaceType?: unknown;
  DomainName?: unknown;
  FederationBrandName?: unknown;
}

@Injectable()
export class MicrosoftDiscoveryService implements MicrosoftDiscovery {
  private readonly cache = new Map<string, { at: number; value: DomainDiscovery }>();

  async describeDomain(domain: string): Promise<DomainDiscovery> {
    const normalised = domain.trim().toLowerCase();
    if (normalised.length > MAX_DOMAIN_LENGTH || !DOMAIN_PATTERN.test(normalised)) {
      return UNKNOWN_DOMAIN;
    }
    const cached = this.cache.get(normalised);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const value = await this.lookup(normalised);
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(normalised, { at: Date.now(), value });
    return value;
  }

  private async lookup(domain: string): Promise<DomainDiscovery> {
    const realm = await this.getJson<UserRealmResponse>(
      `${LOGIN_BASE}/common/userrealm/${encodeURIComponent(`${PLACEHOLDER_LOCAL_PART}@${domain}`)}?api-version=2.0`,
    );
    if (!realm) return UNKNOWN_DOMAIN;

    const namespaceType = typeof realm.NameSpaceType === "string" ? realm.NameSpaceType : "";
    if (namespaceType.toLowerCase() === "unknown") return UNKNOWN_DOMAIN;

    const realmDomain = typeof realm.DomainName === "string" ? realm.DomainName.toLowerCase() : "";
    if (realmDomain === CONSUMER_REALM) {
      return { kind: "personal", tenantId: null, organisationName: null };
    }

    const brand =
      typeof realm.FederationBrandName === "string" && realm.FederationBrandName.trim()
        ? realm.FederationBrandName.trim()
        : null;
    return { kind: "work", tenantId: await this.getTenantId(domain), organisationName: brand };
  }

  /** `issuer` is `https://login.microsoftonline.com/<guid>/v2.0`. A work tenant
   *  with no readable issuer still returns kind "work" — we simply fall back to
   *  the generic `organizations` admin-consent form. */
  private async getTenantId(domain: string): Promise<string | null> {
    const config = await this.getJson<{ issuer?: unknown }>(
      `${LOGIN_BASE}/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
    );
    if (!config || typeof config.issuer !== "string") return null;
    return /\/([0-9a-f-]{36})\//i.exec(config.issuer)?.[1] ?? null;
  }

  /** Fails silently by design — see MicrosoftDiscovery.describeDomain. Nothing
   *  from these responses is ever echoed to a user, only classified. */
  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
