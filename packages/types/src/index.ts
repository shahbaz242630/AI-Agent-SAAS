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
  "imports:read",
  "imports:write",
  "permissions:read",
  "permissions:manage",
  "reminders:read",
  "reminders:write",
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
    "imports:read",
    "imports:write",
    // BRD §6: finance configures reminder sequences; everyone reads them.
    "reminders:read",
    "reminders:write",
  ],
  sales: ["customers:read", "contacts:read", "invoices:read", "imports:read", "reminders:read"],
  reception: ["customers:read", "contacts:read", "invoices:read", "imports:read", "reminders:read"],
  read_only: ["customers:read", "contacts:read", "invoices:read", "imports:read", "reminders:read"],
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

// --- Slice 1.3: CSV/Excel invoice import ---

/** Accepted import file types (plan §3). Legacy .xls (BIFF) is rejected. */
export const IMPORT_FILE_TYPES = ["csv", "xlsx"] as const;

export type ImportFileType = (typeof IMPORT_FILE_TYPES)[number];

/**
 * The four STORED import statuses (plan §3 — CHECK constraint in migration
 * 0007). 'confirmed' is not a stored state: confirm runs synchronously to
 * completion (plan §7.8). Status changes only via the imports module status
 * machine (the 1.2 pattern).
 */
export const IMPORT_STATUSES = ["uploaded", "completed", "failed", "cancelled"] as const;

export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** The staged-row statuses (plan §3 — CHECK constraint in migration 0007). */
export const IMPORT_ROW_STATUSES = [
  "valid",
  "invalid",
  "duplicate",
  "suppressed",
  "imported",
  "skipped",
] as const;

export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** One import upload as the API exposes it (list + preview/report header). */
export interface ImportSummary {
  id: string;
  originalFilename: string;
  fileType: ImportFileType;
  status: ImportStatus;
  /** Resolved file-column → canonical-field mapping (echoed from upload). */
  mapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  suppressedRows: number;
  createdRows: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One staged row as the API exposes it (preview before confirm; report after). */
export interface ImportRowView {
  id: string;
  /** 1-based position of the data row in the uploaded file. */
  rowNumber: number;
  /** The original file row (file column names → raw string values). */
  raw: Record<string, string>;
  status: ImportRowStatus;
  /** Row-level validation errors and informational flags (e.g. customer
   *  auto-creation, plan §7.2); empty when there is nothing to report. */
  errors: string[];
  /** The Draft invoice created at confirm (plan §7.7); null before confirm. */
  createdInvoiceId: string | null;
}

/** GET .../imports/:importId — preview before confirm, report after (plan §3). */
export interface ImportDetail extends ImportSummary {
  rows: ImportRowView[];
}

// --- Slice 1.4: PDF extraction ---

/** The four STORED invoice-document statuses (plan §3 — CHECK constraint in
 *  migration 0008). Status changes only via the invoice-documents module
 *  status machine (the 1.2/1.3 pattern). */
export const INVOICE_DOCUMENT_STATUSES = ["uploaded", "extracted", "confirmed", "failed"] as const;

export type InvoiceDocumentStatus = (typeof INVOICE_DOCUMENT_STATUSES)[number];

/**
 * The fields the extraction provider attempts to pull from a PDF (plan §3) —
 * the SAME ten canonical fields as the 1.3 import. This list deliberately
 * mirrors IMPORT_CANONICAL_FIELDS in @eva/validation (types must not depend
 * on validation); keep the two in sync.
 */
export const EXTRACTABLE_FIELDS = [
  "invoiceNumber",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
  "customerReference",
  "customerName",
  "customerEmail",
  "contactName",
  "contactEmail",
] as const;

export type ExtractableField = (typeof EXTRACTABLE_FIELDS)[number];

/** One extracted field: the raw string value (null when not found) plus a
 *  rule-derived confidence in [0, 1] (plan §3). */
export interface ExtractedFieldValue {
  value: string | null;
  confidence: number;
}

/** One uploaded invoice PDF as the API exposes it in lists (plan §3). The
 *  PDF bytes themselves are only ever streamed by the file endpoint. */
export interface InvoiceDocumentSummary {
  id: string;
  originalFilename: string;
  sizeBytes: number;
  status: InvoiceDocumentStatus;
  /** Sanitised, actionable failure reason when status is 'failed'. */
  extractionError: string | null;
  /** The Draft invoice created at confirm (plan §7.7); null before confirm. */
  invoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * GET .../invoice-documents/:documentId — the review payload (plan §3).
 * `extractedFields` and `extractionNotes` are both sourced from the
 * extracted_fields jsonb column: a `{ fields, notes }` document where fields
 * maps canonical field → { value, confidence } and notes carries extractor
 * remarks (e.g. multi-invoice detection, plan §7.3).
 */
export interface InvoiceDocumentDetail extends InvoiceDocumentSummary {
  /** Per-field extraction draft (null until extraction has run); missing or
   *  low-confidence entries are completed by the human at review (plan §7.7). */
  extractedFields: Partial<Record<ExtractableField, ExtractedFieldValue>> | null;
  extractionNotes: string[];
}

/** Product module identifiers (BRD Section 4) — used by entitlements from Slice 0.3. */
export const MODULE_IDS = [
  "email_credit_controller",
  "voice_credit_controller",
  "lead_follow_up_agent",
  "ai_receptionist",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

// --- Slice 1.5: reminder sequence ---

/**
 * The six reminder stages (BRD 4.1; plan §3/§7.1) — CHECK constraint in
 * migration 0009. `final_escalation` is the internal handover to a human, not
 * a customer-facing email.
 */
export const REMINDER_STEP_KEYS = [
  "pre_due_3",
  "due_date",
  "overdue_7",
  "overdue_14",
  "overdue_30",
  "final_escalation",
] as const;

export type ReminderStepKey = (typeof REMINDER_STEP_KEYS)[number];

/** What a scheduled action does when it fires (plan §3) — CHECK in 0009. */
export const REMINDER_ACTION_TYPES = ["email", "internal_escalation"] as const;

export type ReminderActionType = (typeof REMINDER_ACTION_TYPES)[number];

/**
 * The full scheduled-action lifecycle (plan §3 — CHECK constraint in
 * migration 0009): slice 1.5 writes only pending/ready/cancelled;
 * claimed/sent/failed/skipped are driven by 1.7 via conditional-update claim.
 */
export const SCHEDULED_ACTION_STATUSES = [
  "pending",
  "ready",
  "claimed",
  "sent",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type ScheduledActionStatus = (typeof SCHEDULED_ACTION_STATUSES)[number];

/** Human escalation lifecycle (plan §3) — CHECK constraint in migration 0009. */
export const HUMAN_ESCALATION_STATUSES = ["open", "resolved"] as const;

export type HumanEscalationStatus = (typeof HUMAN_ESCALATION_STATUSES)[number];

/**
 * The default stage definitions (BRD 4.1; plan §3/§7.1) — the single source
 * of truth the API provisions for each organisation. Offsets are days
 * relative to the invoice due_date (negative = before); `final_escalation`
 * fires at +37, seven days after the last email stage.
 */
export const DEFAULT_REMINDER_STEPS: ReadonlyArray<{
  key: ReminderStepKey;
  offsetDays: number;
  actionType: ReminderActionType;
}> = [
  { key: "pre_due_3", offsetDays: -3, actionType: "email" },
  { key: "due_date", offsetDays: 0, actionType: "email" },
  { key: "overdue_7", offsetDays: 7, actionType: "email" },
  { key: "overdue_14", offsetDays: 14, actionType: "email" },
  { key: "overdue_30", offsetDays: 30, actionType: "email" },
  { key: "final_escalation", offsetDays: 37, actionType: "internal_escalation" },
];

/** One reminder step as the API exposes it (plan §3). */
export interface ReminderStepDto {
  id: string;
  key: ReminderStepKey;
  /** Days relative to the invoice due_date (negative = before). */
  offsetDays: number;
  actionType: ReminderActionType;
  enabled: boolean;
}

/** GET .../reminder-sequence — the org's sequence with its steps (plan §3). */
export interface ReminderSequenceDto {
  id: string;
  name: string;
  isDefault: boolean;
  steps: ReminderStepDto[];
}

/** One scheduled action as the API exposes it (plan §3). */
export interface ScheduledActionDto {
  id: string;
  invoiceId: string;
  reminderStepId: string;
  actionType: ReminderActionType;
  /** Calendar date (YYYY-MM-DD) in the organisation timezone. */
  scheduledDate: string;
  status: ScheduledActionStatus;
  idempotencyKey: string;
}

/** One human escalation as the API exposes it (plan §3). */
export interface HumanEscalationDto {
  id: string;
  invoiceId: string;
  scheduledActionId: string;
  reason: string;
  status: HumanEscalationStatus;
  /** ISO-8601 UTC timestamp; null until resolved. */
  resolvedAt: string | null;
  /** Resolving user's id; null until resolved. */
  resolvedBy: string | null;
  /** Resolution notes; null until supplied. */
  notes: string | null;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
}
