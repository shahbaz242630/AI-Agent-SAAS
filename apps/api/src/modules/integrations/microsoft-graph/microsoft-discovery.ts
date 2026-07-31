/**
 * Microsoft account discovery: "what kind of Microsoft account is this address,
 * and if it belongs to an organisation, which one?" — asked BEFORE the user
 * leaves Eva, using only unauthenticated Microsoft endpoints.
 *
 * It exists because of defect F1. Microsoft reports "your administrator must
 * approve this" and "you pressed cancel" with the identical `access_denied`,
 * so the callback cannot tell them apart. Knowing the account kind up front is
 * what lets the failure screen be right instead of a guess:
 *
 * - a **work/school** account may genuinely need an administrator, and we can
 *   build the tenant-specific approval link and name their organisation;
 * - a **personal** account has no administrator at all, so telling its owner to
 *   "ask your IT department" sends a sole trader on an errand that cannot end.
 *
 * A separate port from MicrosoftGraphProvider because it talks to the identity
 * platform rather than Graph, needs no token, and must be stubbable on its own.
 */

/** DI token for the active discovery implementation. */
export const MICROSOFT_DISCOVERY = Symbol("MICROSOFT_DISCOVERY");

export type MicrosoftAccountKind = "work" | "personal" | "unknown";

export interface DomainDiscovery {
  kind: MicrosoftAccountKind;
  /** Entra tenant GUID. Only ever set for `work`. */
  tenantId: string | null;
  /** The customer's own organisation name, as Microsoft brands it — so copy can
   *  say "whoever manages Microsoft 365 at Acme Ltd" rather than "your admin". */
  organisationName: string | null;
}

export const UNKNOWN_DOMAIN: DomainDiscovery = {
  kind: "unknown",
  tenantId: null,
  organisationName: null,
};

export interface MicrosoftDiscovery {
  /** Never rejects. Any failure, timeout or unexpected shape answers
   *  UNKNOWN_DOMAIN — discovery is an enhancement and must never be able to
   *  block a connection. */
  describeDomain(domain: string): Promise<DomainDiscovery>;
}
