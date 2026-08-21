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

/**
 * PATCH .../contacts/:contactId payload (Slice 1.1).
 *
 * ⚠️ THE OPTIONAL FIELDS ARE NULLABLE HERE AND NOT ON CREATE, and the
 * difference is the same one `updateInvoiceRequestSchema` documents below. On
 * create, "this contact has no phone" is said by leaving the field out. On
 * update it cannot be: an absent field means "leave this alone", so without an
 * explicit null there is no way to REMOVE an address or a number that turned
 * out to be wrong. A form would clear the box, report success, and keep the old
 * value — the exact failure this project keeps finding.
 *
 * ⚠️ CLEARING `email` IS A REAL DECISION, NOT A TIDY-UP. A contact with no
 * address cannot be chased — `reminder-eligibility.ts` holds the invoice — so
 * whatever offers this must say so before it happens.
 */
export const updateContactRequestSchema = createContactRequestSchema.partial().extend({
  email: z.email().max(320).nullable().optional(),
  phone: z.string().trim().min(1).max(50).nullable().optional(),
  jobTitle: z.string().trim().min(1).max(100).nullable().optional(),
});

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

/**
 * PATCH /organisations/:id/settings payload (Slice 1.6c, task 13).
 *
 * ⚠️ THE CODE IS NOT UPPERCASED FOR THE CALLER, deliberately. The money layer
 * indexes its minor-unit table by exact ISO 4217 code, so `gbp` would miss and
 * silently take the 2-digit fallback — right for GBP and wrong for KWD (3
 * digits) and JPY (0). A refusal that names the rule beats a value that looks
 * accepted and means something else. The web uppercases what a human types
 * before it gets here, which is where that belongs.
 */
export const updateOrganisationSettingsRequestSchema = z.object({
  defaultCurrency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "defaultCurrency must be a 3-letter uppercase ISO 4217 code"),
});

export type UpdateOrganisationSettingsRequest = z.infer<
  typeof updateOrganisationSettingsRequestSchema
>;

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
 *
 * ⚠️ `contactId` IS NULLABLE HERE AND NOT ON CREATE, and the difference is real
 * (slice 1.6c, task 4). On create, "no reminder recipient" is said by leaving
 * the field out. On update it cannot be: an absent field means "leave this
 * alone", so without an explicit null there is no way to UNDO having picked the
 * wrong person — the edit screen would offer "Nobody in particular", accept the
 * click and silently change nothing, which is the failure this project keeps
 * finding (the right outcome reported, the wrong record kept).
 */
export const updateInvoiceRequestSchema = createInvoiceRequestSchema
  .omit({ status: true })
  .partial()
  .extend({ contactId: z.uuid().nullable().optional() })
  .strict();

export type UpdateInvoiceRequest = z.infer<typeof updateInvoiceRequestSchema>;

/**
 * POST .../invoices/:invoiceId/payments payload (slice 1.6c, task 5).
 *
 * ⚠️ NO `status` FIELD, AND THERE MUST NEVER BE ONE. What a payment does to the
 * status is decided by the resulting BALANCE inside the state machine — that is
 * what stops "mark this paid" from being an assertion anybody can make without
 * money to back it.
 *
 * ⚠️ NO UPPER BOUND ON THE AMOUNT. Overpayment is allowed (founder ruling
 * 2026-08-02): a debtor who rounds up, pays twice, or settles two invoices with
 * one transfer is a real thing, and refusing to record what actually arrived
 * would leave the customer's books disagreeing with their bank. The balance
 * clamps at zero rather than going negative.
 */
export const recordPaymentRequestSchema = z
  .object({
    /** Integer minor units of the invoice's own currency; never a float. */
    amountMinorUnits: z.number().int().positive(),
    /** When the money arrived. Defaults to now — a payment is usually recorded
     *  the day it lands, and a required field there is friction for nothing. */
    paidAt: z.iso.date().optional(),
  })
  .strict();

export type RecordPaymentRequest = z.infer<typeof recordPaymentRequestSchema>;

/**
 * POST /organisations/:id/invoices — one typed row of the book (slice 1.6c).
 *
 * ⚠️ THE SAME COLUMNS AS THE CSV IMPORTER, deliberately. A row somebody types
 * and a row they upload are the same thing, and the API resolves the client
 * through the same `common/ledger` code either way — so the two cannot drift
 * into creating clients differently.
 */
export const addBookRowRequestSchema = z
  .object({
    /**
     * The client this invoice belongs to, when the person raising it PICKED one
     * that already exists (founder, 2026-08-18).
     *
     * ⚠️ AN IDENTITY BEATS A NAME, AND THAT IS THE WHOLE POINT. `clientName`
     * alone is resolved by case-insensitive exact match, which cannot tell two
     * real clients called "Imran Khalid" apart — a freelancer with two
     * same-named customers had no way to say which one, and the API could only
     * refuse. When this is present the name is not matched at all.
     *
     * ⚠️ `clientName` STAYS REQUIRED even alongside this. It is what a brand new
     * client is created FROM, and keeping it lets the two paths share one
     * payload instead of becoming two endpoints that drift.
     */
    customerId: z.uuid().optional(),
    clientName: z.string().trim().min(1).max(200),
    clientEmail: z.email().max(320).optional(),
    clientReference: z.string().trim().min(1).max(100).optional(),
    /** Who Eva writes to. Without an email there is nobody to chase. */
    contactName: z.string().trim().min(1).max(200).optional(),
    contactEmail: z.email().max(320).optional(),
    /**
     * ⚠️ E.164 ONLY — `+447700900123`. The founder's reason is the calling
     * agent, and it is right: a dialler cannot ring "07700 900123" without
     * knowing which country it belongs to. Free text is cheap now and a
     * data-cleaning project later, so the country code is required rather than
     * hoped for.
     */
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/, "phone must include the country code, like +447700900123")
      .optional(),
    invoiceNumber: z.string().trim().min(1).max(50),
    amountMinorUnits: z.number().int().positive(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "currency must be a 3-letter uppercase ISO 4217 code")
      .default("GBP"),
    issueDate: isoDate.optional(),
    dueDate: isoDate,
    /** Unlike an import, a typed row may start chasing at once — see the service. */
    status: z.enum(["draft", "active"]).default("draft"),
  })
  .strict();

export type AddBookRowRequest = z.infer<typeof addBookRowRequestSchema>;

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
 * Header auto-mapping (Phase 1.3 plan §3): when the client sends no `mapping`
 * form field, file headers are matched to canonical fields case-insensitively
 * after normalising (lowercase, alphanumerics only — "Invoice Number" →
 * invoiceNumber). Unmapped required fields surface as per-row errors at
 * staging.
 *
 * ⚠️ IT LIVES IN THIS PACKAGE SO A TEST CAN HOLD IT AGAINST THE WORDS THE
 * UPLOAD SCREEN PRINTS. It sat in `apps/api` and the screen's list of
 * "Columns Eva understands" sat in `apps/web`, with nothing between them — so
 * the screen advertised "Client email" and "Your client reference", neither of
 * which the matcher had ever heard of, and a file using exactly the headings we
 * recommend had both columns silently dropped. Found by uploading one,
 * 2026-08-18. `import-messages.spec.ts` now fails if the two drift again.
 *
 * ⚠️ THE PRODUCT SAYS "CLIENT" AND THIS TABLE IS KEYED ON "CUSTOMER". That is
 * the whole trap: `customerName` already accepted "clientname" and "client",
 * which made the omission on the other two look deliberate rather than missed.
 * Every field a person can see must accept the word THEY were shown.
 */
const IMPORT_HEADER_ALIASES: ReadonlyArray<readonly [ImportCanonicalField, readonly string[]]> = [
  ["invoiceNumber", ["invoicenumber", "invoiceno", "invno", "invnumber", "invoice", "invoiceref"]],
  ["amount", ["amount", "total", "value", "amountdue", "totaldue", "invoiceamount", "gross"]],
  ["currency", ["currency", "ccy", "currencycode"]],
  ["issueDate", ["issuedate", "invoicedate", "date", "issued"]],
  ["dueDate", ["duedate", "due", "paymentdue", "datepaymentdue"]],
  [
    "customerReference",
    [
      "customerreference",
      "customerref",
      "clientreference",
      "clientref",
      "yourclientreference",
      "accountreference",
      "accountref",
      "accountnumber",
      "account",
      "reference",
      "ref",
    ],
  ],
  [
    "customerName",
    ["customername", "customer", "clientname", "client", "companyname", "company", "accountname"],
  ],
  [
    "customerEmail",
    [
      "customeremail",
      "clientemail",
      "clientemailaddress",
      "email",
      "emailaddress",
      "customeremailaddress",
    ],
  ],
  ["contactName", ["contactname", "contact", "attention", "attn"]],
  ["contactEmail", ["contactemail", "contactemailaddress"]],
];

function normaliseImportHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps file headers to canonical fields; the first header claiming a field wins. */
export function autoMapHeaders(headers: string[]): Record<string, ImportCanonicalField> {
  const aliasToField = new Map<string, ImportCanonicalField>();
  for (const [field, aliases] of IMPORT_HEADER_ALIASES) {
    for (const alias of aliases) {
      if (!aliasToField.has(alias)) aliasToField.set(alias, field);
    }
  }
  const mapping: Record<string, ImportCanonicalField> = {};
  const claimed = new Set<ImportCanonicalField>();
  for (const header of headers) {
    const field = aliasToField.get(normaliseImportHeader(header));
    if (field && !claimed.has(field)) {
      mapping[header] = field;
      claimed.add(field);
    }
  }
  return mapping;
}

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
    /**
     * Which provider to connect (Slice 3.1b step 3).
     *
     * ⚠️ DEFAULTS TO `microsoft` SO EVERY EXISTING CALLER KEEPS WORKING. The
     * settings screen and onboarding both called this endpoint with no provider
     * for months; making it required would 400 them all, and the failure would
     * land on the product we already sell rather than on the new one.
     */
    provider: z.enum(["microsoft", "google"]).optional(),
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

// --- Slice 3.1a: the lead record ---

/**
 * Where a lead in **Lead Follow-up by Email** can come from.
 *
 * ⚠️ ONE SOURCE, AND IT IS AN EMAIL — founder ruling 2026-08-21. This product
 * is one mailbox in and a reply out. A business puts a single address on its
 * website and on its enquiry form, so a web-form lead ARRIVES AS EMAIL. There
 * is no second intake pipeline to model, which is why `website_form` is absent
 * rather than pending.
 *
 * ⚠️ `missed_call`, `existing_customer` AND `callback_request` WERE HERE AND
 * WERE A SCOPE LEAK. All three are call-shaped, and 3.1a offered them on a form
 * inside a product that can only answer by email — so a lead with a phone
 * number and no address was creatable in a product with no way to ring anybody.
 * They belong to Lead Follow-up by Call (`lead_follow_up_voice`), a separate
 * purchase that is not built.
 *
 * ⚠️ THE DATABASE STILL ACCEPTS ALL THREE, DELIBERATELY. One real enquiry was
 * logged as `callback_request` on 2026-08-20, and `lead_evidence` is immutable
 * by design — the app role holds no UPDATE on it, and rewriting the channel
 * would be falsifying the proof of how somebody got in touch. History stays
 * legal; what changed is that nothing produces those values any more.
 */
export const LEAD_SOURCES = ["email_enquiry"] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * POST /organisations/:organisationId/leads — record an enquiry that arrived
 * in the customer's mailbox.
 *
 * ⚠️ NO SCREEN CALLS THIS. The manual "Log an enquiry" form was removed on
 * 2026-08-21 with the call sources it existed to offer. This stays as the seam
 * 3.1b wires the forwarded mailbox to, and as the only way to prove the
 * lead-plus-evidence transaction end to end until then.
 *
 * ⚠️ `receivedAt` IS REQUIRED AND IS NOT "NOW". Speed-to-lead (BRD 4.3) is
 * measured from when the enquiry HAPPENED, which for a forwarded email is the
 * header date, not the moment our poller noticed it. Getting this from the
 * clock would make every response target this product reports a fiction.
 *
 * ⚠️ AN EMAIL ADDRESS IS REQUIRED, NOT "ONE OF EMAIL OR PHONE". Until
 * 2026-08-21 either would do, which is how a lead reachable ONLY by phone
 * could be created inside a product that can only answer by email — a record
 * that sits in the book forever looking like work nobody did, because there is
 * genuinely nothing Eva can do with it. An `email_enquiry` always has a sender,
 * so requiring it costs nothing real and closes the hole.
 *
 * ⚠️ THE DATABASE STILL SAYS "EMAIL OR PHONE" AND IS NOT WRONG. `leads` is a
 * platform table shared with Lead Follow-up by Call, where a missed call has a
 * number and no address. The narrower rule belongs to this product, so it lives
 * in this schema; the CHECK stays the backstop for both.
 *
 * `contactPhone` stays optional and is worth keeping: enquiry emails routinely
 * say "call me on…", and the call product will want it.
 */
export const createLeadRequestSchema = z.object({
  source: z.enum(LEAD_SOURCES),
  contactName: z.string().trim().min(1).max(200).optional(),
  contactEmail: z.email().max(320),
  contactPhone: z.string().trim().min(1).max(50).optional(),
  /** What they asked for, in their words where we have them. */
  enquiry: z.string().trim().min(1).max(4000).optional(),
  receivedAt: z.iso.datetime(),
  /** Set when the enquiry is recognised as coming from an existing client. */
  customerId: z.uuid().optional(),
  /**
   * Verbatim evidence of the enquiry — the note taken from the call, the
   * message they left. Kept in `lead_evidence`, which nothing can edit.
   */
  evidenceExcerpt: z.string().trim().min(1).max(4000).optional(),
  /** The channel's own reference where one exists — a Graph message id. */
  evidenceExternalId: z.string().trim().min(1).max(200).optional(),
});

export type CreateLeadRequest = z.infer<typeof createLeadRequestSchema>;

// --- Slice 3.1a follow-up: correcting a do-not-contact ---

/**
 * The channels a do-not-contact covers. Mirrors `SUPPRESSION_CHANNELS` in the
 * API's suppression module and the CHECK behind it.
 *
 * ⚠️ `call`, NOT `phone`. Slice 1.1 settled that vocabulary and the database
 * enforces it; a hand-written "phone" is refused by a path nothing exercises
 * until a real person asks not to be contacted.
 */
export const SUPPRESSION_CHANNEL_KEYS = ["email", "call"] as const;

/**
 * POST /organisations/:organisationId/suppression/corrections — record that a
 * do-not-contact entry was made in error.
 *
 * ⚠️ THE ENTRY IS IDENTIFIED BY CHANNEL AND VALUE, NOT BY AN ID, because after
 * migration 0028 there is no row with a lifetime to point at — the table is a
 * log of events about a value. The value IS the identity.
 *
 * ⚠️ THE REASON IS REQUIRED, HERE AND AT THE DATABASE. Undoing somebody's
 * do-not-contact is the one action in this area that has to be answerable for
 * later, and a CHECK constraint keeps that true for callers that never pass
 * through this schema. 10 characters minimum so "mistake" alone will not do:
 * the audit line has to mean something to whoever reads it in a year.
 */
export const correctSuppressionRequestSchema = z.object({
  channel: z.enum(SUPPRESSION_CHANNEL_KEYS),
  value: z.string().trim().min(1).max(320),
  reason: z.string().trim().min(10).max(500),
});

export type CorrectSuppressionRequest = z.infer<typeof correctSuppressionRequestSchema>;
