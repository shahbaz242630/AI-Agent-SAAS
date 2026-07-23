/**
 * Shared cross-app contracts (BRD Section 8).
 * Only types that genuinely cross module/app boundaries belong here.
 */

/** Liveness payload returned by every service's GET /health endpoint. */
export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
}

/** Readiness payload returned by GET /health/ready — dependency connectivity. */
export interface ReadinessResponse {
  status: "ok" | "error";
  service: string;
  version: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  checks: {
    database: "up" | "down";
  };
}

/** Organisation roles (BRD Section 7). Enforced in the backend on every request. */
export const ORGANISATION_ROLES = [
  "owner",
  "administrator",
  "finance",
  "sales",
  "reception",
  "read_only",
] as const;

export type OrganisationRole = (typeof ORGANISATION_ROLES)[number];

/** Product module identifiers (BRD Section 4) — used by entitlements from Slice 0.3. */
export const MODULE_IDS = [
  "email_credit_controller",
  "voice_credit_controller",
  "lead_follow_up_agent",
  "ai_receptionist",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
