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

/**
 * Permission keys checked by API guards (Slice 1.1; BRD 7 amendment). Guards
 * never name roles — they ask whether the caller's role holds the permission
 * in this organisation (org mapping → DEFAULT_ROLE_PERMISSIONS fallback).
 */
export const PERMISSION_KEYS = [
  "customers:read",
  "customers:write",
  "contacts:read",
  "contacts:write",
  "invoices:read",
  "invoices:write",
  "permissions:read",
  "permissions:manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * BRD 7 default role→permission matrix. Applies to every organisation that
 * has no custom rows in organisation_role_permissions. High-risk actions
 * (legal threats, fees, discounts, marking paid, commitments) are NEVER
 * permission-keyed — they stay human-confirmed regardless of configuration.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<OrganisationRole, readonly PermissionKey[]> = {
  owner: PERMISSION_KEYS,
  administrator: PERMISSION_KEYS,
  finance: [
    "customers:read",
    "customers:write",
    "contacts:read",
    "contacts:write",
    "invoices:read",
    "invoices:write",
  ],
  sales: ["customers:read", "contacts:read", "invoices:read"],
  reception: ["customers:read", "contacts:read", "invoices:read"],
  read_only: ["customers:read", "contacts:read", "invoices:read"],
};

// --- Slice 1.2: invoice records ---

/**
 * The nine STORED invoice statuses (BRD 4.1; Phase 1.2 plan §7.1). Only these
 * ever appear in invoices.status (enforced by a CHECK constraint); changes go
 * through the invoices module state machine. Outcome statuses
 * (promise_to_pay … written_off) have no API path until slice 1.8.
 */
export const INVOICE_STORED_STATUSES = [
  "draft",
  "active",
  "paused",
  "cancelled",
  "promise_to_pay",
  "disputed",
  "partially_paid",
  "paid",
  "written_off",
] as const;

export type InvoiceStoredStatus = (typeof INVOICE_STORED_STATUSES)[number];

/**
 * Time-derived statuses (plan §7.1): never stored — computed at read time
 * from due_date + the organisation timezone, and only ever applied to Active
 * invoices.
 */
export const INVOICE_COMPUTED_STATUSES = ["due_soon", "due_today", "overdue"] as const;

export type InvoiceComputedStatus = (typeof INVOICE_COMPUTED_STATUSES)[number];

/** What API responses expose: stored status, or a computed one when Active. */
export type InvoiceDisplayStatus = InvoiceStoredStatus | InvoiceComputedStatus;

/** Product module identifiers (BRD Section 4) — used by entitlements from Slice 0.3. */
export const MODULE_IDS = [
  "email_credit_controller",
  "voice_credit_controller",
  "lead_follow_up_agent",
  "ai_receptionist",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
