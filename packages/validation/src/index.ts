import { z } from "zod";
import {
  MAX_CLIENTS_PER_ALLOCATION,
  MODULE_KEYS,
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

/**
 * PUT /organisations/:id/customers/allocation payload (Slice 1.6b).
 *
 * `emailAccountId: null` is a LEGAL, deliberate value meaning "back to the
 * default mailbox" — the explicit un-file action (ruling 1). It is `nullable`
 * rather than `optional` on purpose: omitting the key entirely would be
 * ambiguous between "un-file these" and "I forgot to say", and this endpoint
 * moves other people's customer relationships around.
 */
export const allocateClientsRequestSchema = z.object({
  customerIds: z.array(z.uuid()).min(1).max(MAX_CLIENTS_PER_ALLOCATION),
  emailAccountId: z.uuid().nullable(),
});

export type AllocateClientsRequest = z.infer<typeof allocateClientsRequestSchema>;

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
 * (plan §3) — shape only, WITHOUT the cross-field refinement, so Slice 1.4's
 * per-row corrections schema can compose it (zod cannot .partial() a schema
 * carrying refinements). Validates SHAPE at staging time only — semantic
 * parsing (amount → integer minor units, ISO/UK date forms) happens in the
 * API parser, not here.
 */
const importRowBaseSchema = z.object({
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
});

/**
 * The staged import row (plan §3): the base shape plus the requirement that
 * invoiceNumber/amount/dueDate are present (base schema) and at least one of
 * customerReference/customerName is given; currency is optional (the parser
 * defaults GBP); emails are optional but must be valid when present.
 */
export const importRowSchema = importRowBaseSchema.refine(
  (row) => row.customerReference !== undefined || row.customerName !== undefined,
  { message: "at least one of customerReference or customerName is required" },
);

export type ImportRow = z.infer<typeof importRowSchema>;

// --- Slice 1.4: PDF extraction ---

/** One extracted field value: the raw string (null when not found) plus a
 *  rule-derived confidence in [0, 1] (plan §3). */
export const extractedFieldValueSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/**
 * The extraction draft stored in invoice_documents.extracted_fields (plan §3):
 * a partial map of canonical field → { value, confidence }. Missing fields
 * are simply absent (completed by the human at review, plan §7.7).
 */
export const extractedFieldsSchema = z.partialRecord(
  z.enum(IMPORT_CANONICAL_FIELDS),
  extractedFieldValueSchema,
);

/**
 * POST .../invoice-documents/:documentId/confirm payload (plan §7.7 — the
 * hybrid ruling): ALWAYS the complete, final, human-reviewed field set,
 * whether pre-filled from extraction or entered fully manually after a
 * failure. Mirrors createInvoiceRequestSchema (1.2) for the invoice fields
 * plus the 1.3 import-row customer/contact semantics: at least one of
 * customerReference/customerName is required; emails optional but valid.
 * No `status` — confirm always creates a Draft (BRD 4.1 hard rule).
 */
export const confirmInvoiceDocumentRequestSchema = z
  .object({
    invoiceNumber: z.string().trim().min(1).max(50),
    /** Integer minor units (pence); money is never float (BRD 10). */
    amountMinorUnits: z.number().int().positive(),
    /** ISO 4217 alpha-3, uppercase. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "currency must be a 3-letter uppercase ISO 4217 code")
      .default("GBP"),
    /** Defaults to the confirmation day in the organisation timezone when omitted. */
    issueDate: isoDate.optional(),
    dueDate: isoDate,
    customerReference: z.string().trim().min(1).max(100).optional(),
    customerName: z.string().trim().min(1).max(200).optional(),
    customerEmail: z.email().max(320).optional(),
    contactName: z.string().trim().min(1).max(200).optional(),
    contactEmail: z.email().max(320).optional(),
  })
  .refine((body) => body.customerReference !== undefined || body.customerName !== undefined, {
    message: "at least one of customerReference or customerName is required",
  });

export type ConfirmInvoiceDocumentRequest = z.infer<typeof confirmInvoiceDocumentRequestSchema>;

/**
 * Optional `corrections` map on the 1.3 imports confirm (plan §7.9 — CSV/XLSX
 * parity with the PDF review-fix-save flow): `{ rowNumber: { field: value } }`
 * where each entry is a PARTIAL import row (raw string values, as staged).
 * The API merges a correction over the staged row and re-validates against
 * the full importRowSchema, so the base shape is reused without its
 * refinement. Keys are 1-based row numbers (coerced from JSON strings).
 */
export const importRowCorrectionsSchema = z.record(
  z.coerce.number().int().positive(),
  // Strict: an unknown correction field is a client error (400), never
  // silently dropped (the 1.2 update-invoice precedent).
  importRowBaseSchema.partial().strict(),
);

export type ImportRowCorrections = z.infer<typeof importRowCorrectionsSchema>;

/**
 * Optional body of POST .../imports/:importId/confirm (plan §7.9 — CSV/XLSX
 * parity with the PDF review-fix-save flow): per-row corrections, merged over
 * the staged raw values and re-validated before the row is processed.
 */
export const confirmImportRequestSchema = z.object({
  corrections: importRowCorrectionsSchema.optional(),
});

export type ConfirmImportRequest = z.infer<typeof confirmImportRequestSchema>;

// --- Slice 1.5: reminder sequence ---

/**
 * PATCH .../reminder-sequence/steps/:stepId payload (Slice 1.5, plan §3):
 * toggle a step and/or shift its offset. Offsets stay within −30…+90 days
 * relative to the invoice due_date; at least one field is required.
 */
export const updateReminderStepSchema = z
  .object({
    enabled: z.boolean().optional(),
    offsetDays: z.number().int().min(-30).max(90).optional(),
  })
  .refine((body) => body.enabled !== undefined || body.offsetDays !== undefined, {
    message: "at least one of enabled or offsetDays is required",
  });

export type UpdateReminderStepInput = z.infer<typeof updateReminderStepSchema>;

// --- Slice 1.6: Outlook connection ---

/**
 * GET /integrations/microsoft/callback query (Slice 1.6, ruling 4).
 *
 * Microsoft sends THREE shapes here, not two:
 *
 * 1. `code` + `state` — consent given.
 * 2. `error` (+ `error_description`, usually `state`) — declined.
 * 3. `admin_consent` + `tenant` — an administrator approved Eva org-wide via
 *    the `/adminconsent` endpoint. **No `code`, and no `state` unless we put
 *    one there.**
 *
 * Shape 3 is defect F2: `state` used to be required, so the customer's IT
 * administrator — the one person in the whole journey we most need to impress —
 * finished approving Eva and landed on raw validation JSON.
 *
 * `state` is therefore optional at the schema level, and the callback decides
 * per shape whether it can proceed without one.
 *
 * Every field is optional ON PURPOSE, and no `.refine` rejects a query that
 * matches none of the three shapes. A rejection here becomes a 400 JSON body,
 * which is precisely the contract violation F2 was: this route owes the browser
 * a redirect in every case, so "this is not a Microsoft callback" is the
 * service's decision to make (`?error=invalid_state`), not the schema's.
 */
export const microsoftCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  /** Microsoft sends the literal capitalised string "True" — not a boolean. */
  admin_consent: z.string().optional(),
  tenant: z.string().optional(),
});

export type MicrosoftCallbackQuery = z.infer<typeof microsoftCallbackQuerySchema>;

/**
 * POST .../mailbox/connect body. The address is optional — it is a `login_hint`
 * for Microsoft (defect F5: without one, someone signed into two accounts can
 * silently connect the wrong mailbox) and the domain we classify to decide
 * whether an administrator can even exist. Eva never asks for the password;
 * that happens at Microsoft.
 */
export const mailboxConnectSchema = z
  .object({
    emailAddress: z.string().trim().email().max(320).optional(),
    /** Which Eva screen this was started from, so the callback returns the user
     *  there. A closed enum, never a URL — the API maps it to a path from its
     *  own table, so a caller cannot choose where the browser lands. */
    flow: z.enum(["onboarding", "settings"]).optional(),
    /**
     * Replace this mailbox rather than adding another (slice 1.6b, ruling 3).
     * The new address inherits the old one's clients and its default status,
     * and the old row is disconnected in the same transaction.
     *
     * It is its own action, NOT "disconnect then reconnect": disconnecting
     * first drops every allocation to the default, so the clients would be
     * chased from the wrong address in the gap and nobody would be told.
     */
    replacesMailboxId: z.uuid().optional(),
  })
  // The whole body is optional: connect worked without one before onboarding
  // existed, and the settings page still calls it that way. Without the default
  // an absent body parses as undefined and 400s.
  .default({});

export type MailboxConnectInput = z.infer<typeof mailboxConnectSchema>;

/** The `:moduleKey` path parameter. Validated against the same closed list the
 *  database CHECK enforces, so an unknown product is a 400 rather than a 500
 *  from a constraint violation. */
export const moduleKeyParamSchema = z.enum(MODULE_KEYS);

/**
 * PUT .../modules/:moduleKey body.
 *
 * `seats` is optional because enabling and resizing are the same endpoint, and
 * an enable that omits it must not silently reset a customer's seat count to
 * the default. Capped: the point of a cap is to be a number a human chose, and
 * nothing here should be able to write four billion.
 */
export const setModuleSchema = z.object({
  enabled: z.boolean(),
  seats: z.number().int().min(1).max(1000).optional(),
});

export type SetModuleInput = z.infer<typeof setModuleSchema>;
