import { z } from "zod";
import {
  ORGANISATION_ROLES,
  PERMISSION_KEYS,
  type HealthResponse,
  type ReadinessResponse,
} from "@eva/types";

/**
 * Shared zod schemas (BRD Section 8). Schemas that validate cross-boundary
 * payloads live here so web, api and worker validate identically.
 */

/** Validates a GET /health payload from any platform service. */
export const healthResponseSchema: z.ZodType<HealthResponse> = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  version: z.string().min(1),
  timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "timestamp must be a parseable ISO-8601 date",
  }),
});

/** Validates a GET /health/ready payload (Slice 0.4). */
export const readinessResponseSchema: z.ZodType<ReadinessResponse> = z.object({
  status: z.enum(["ok", "error"]),
  service: z.string().min(1),
  version: z.string().min(1),
  timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "timestamp must be a parseable ISO-8601 date",
  }),
  checks: z.object({
    database: z.enum(["up", "down"]),
  }),
});

/** POST /organisations payload (Slice 0.3). */
export const createOrganisationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export type CreateOrganisationRequest = z.infer<typeof createOrganisationRequestSchema>;

/** PATCH /organisations/:id/members/:userId payload (Slice 0.3). */
export const updateMemberRoleRequestSchema = z.object({
  roleKey: z.string().min(1),
});

export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>;

// --- Slice 1.1: customers, contacts, role permissions ---

/** POST /organisations/:id/customers payload (Slice 1.1). */
export const createCustomerRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
  reference: z.string().trim().min(1).max(100).optional(),
});

export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;

/** PATCH /organisations/:id/customers/:customerId payload (Slice 1.1). */
export const updateCustomerRequestSchema = createCustomerRequestSchema.partial();

export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;

/** POST /organisations/:id/customers/:customerId/contacts payload (Slice 1.1). */
export const createContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
  jobTitle: z.string().trim().min(1).max(100).optional(),
});

export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

/** PATCH .../contacts/:contactId payload (Slice 1.1). */
export const updateContactRequestSchema = createContactRequestSchema.partial();

export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

/**
 * PUT /organisations/:id/permissions payload (Slice 1.1): the org's FULL
 * desired role→permission mapping (replaces existing grants). Role and
 * permission keys are closed sets from @eva/types.
 */
export const putRolePermissionsRequestSchema = z.object({
  grants: z
    .array(
      z.object({
        roleKey: z.enum(ORGANISATION_ROLES),
        permissionKey: z.enum(PERMISSION_KEYS),
      }),
    )
    .max(ORGANISATION_ROLES.length * PERMISSION_KEYS.length),
});

export type PutRolePermissionsRequest = z.infer<typeof putRolePermissionsRequestSchema>;

// --- Slice 1.2: invoice records ---

/** ISO calendar date (YYYY-MM-DD) for date-only invoice fields. */
const isoDate = z.iso.date();

/**
 * POST /organisations/:id/customers/:customerId/invoices payload (Slice 1.2).
 * `status` may only request "draft" (default) or "active" (invoice already
 * sent) — every later status change goes through the state machine actions.
 */
export const createInvoiceRequestSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(50),
  /** Integer minor units (pence); money is never float (BRD 10). */
  amountMinorUnits: z.number().int().positive(),
  /** ISO 4217 alpha-3, uppercase. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter uppercase ISO 4217 code")
    .default("GBP"),
  /** Defaults to the creation day in the organisation timezone when omitted. */
  issueDate: isoDate.optional(),
  dueDate: isoDate,
  /** Must reference a live contact OF THIS CUSTOMER when set (plan §7.2). */
  contactId: z.uuid().optional(),
  status: z.enum(["draft", "active"]).default("draft"),
});

export type CreateInvoiceRequest = z.infer<typeof createInvoiceRequestSchema>;

/**
 * PATCH .../invoices/:invoiceId payload (Slice 1.2): Draft-only partial
 * update. `status` is deliberately absent and the object is strict, so a
 * status field on an update payload is rejected 400 — status changes ONLY via
 * the state machine actions (BRD 4.1 hard rule).
 */
export const updateInvoiceRequestSchema = createInvoiceRequestSchema
  .omit({ status: true })
  .partial()
  .strict();

export type UpdateInvoiceRequest = z.infer<typeof updateInvoiceRequestSchema>;

// --- Slice 1.3: CSV/Excel import ---

/** Canonical fields a file column can map to (Phase 1.3 plan §3). */
export const IMPORT_CANONICAL_FIELDS = [
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

export type ImportCanonicalField = (typeof IMPORT_CANONICAL_FIELDS)[number];

/**
 * Optional `mapping` form field on POST .../imports (plan §3): file column
 * name → canonical field. Partial — not every canonical field must be mapped;
 * when the mapping is absent the server auto-maps by header name.
 */
export const importMappingSchema = z.record(
  z.string().trim().min(1),
  z.enum(IMPORT_CANONICAL_FIELDS),
);

export type ImportMapping = z.infer<typeof importMappingSchema>;

/** Empty file cells mean "absent", not an invalid value. */
const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

/**
 * One staged import row with RAW string values as they come from the file
 * (plan §3). Validates SHAPE at staging time only — semantic parsing
 * (amount → integer minor units, ISO/UK date forms) happens in the API
 * parser, not here. invoiceNumber/amount/dueDate are required; at least one
 * of customerReference/customerName is required; currency is optional (the
 * parser defaults GBP); emails are optional but must be valid when present.
 */
export const importRowSchema = z
  .object({
    invoiceNumber: z.string().trim().min(1).max(50),
    /** Decimal major units as written in the file (e.g. "1234.56", "£1,234.56"). */
    amount: z.string().trim().min(1),
    currency: emptyToUndefined(z.string().trim().min(1)),
    issueDate: emptyToUndefined(z.string().trim().min(1)),
    dueDate: z.string().trim().min(1),
    customerReference: emptyToUndefined(z.string().trim().min(1)),
    customerName: emptyToUndefined(z.string().trim().min(1)),
    customerEmail: emptyToUndefined(z.email().max(320)),
    contactName: emptyToUndefined(z.string().trim().min(1)),
    contactEmail: emptyToUndefined(z.email().max(320)),
  })
  .refine((row) => row.customerReference !== undefined || row.customerName !== undefined, {
    message: "at least one of customerReference or customerName is required",
  });

export type ImportRow = z.infer<typeof importRowSchema>;
