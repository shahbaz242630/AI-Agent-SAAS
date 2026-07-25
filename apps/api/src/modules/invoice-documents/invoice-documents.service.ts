import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma, withTenant } from "@eva/database";
import type {
  ExtractableField,
  ExtractedFieldValue,
  InvoiceDocumentDetail,
  InvoiceDocumentSummary,
} from "@eva/types";
import type { ConfirmInvoiceDocumentRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import { isSuppressed, normaliseSuppressionValue } from "../../common/suppression/suppression.js";
import { scanUpload } from "../../common/upload/upload-security.js";
import {
  createCustomerFromCanonical,
  createDraftInvoice,
  listLiveCustomers,
  listLiveInvoiceNumbers,
  resolveCustomer,
  resolveOrCreateContact,
  type CanonicalRow,
} from "../../common/ledger/ledger.js";
import { parseImportDate } from "../../common/ledger/values.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { todayInTimezone } from "../invoices/invoice-status.js";
import {
  EXTRACTION_PROVIDER,
  NoTextLayerError,
  type ExtractionProvider,
  type ExtractionResult,
} from "../integrations/extraction/extraction-provider.js";
import { transitionInvoiceDocumentStatus } from "./invoice-document-status-machine.js";

/** 10 MB upload cap (plan §3) — enforced at the interceptor AND here. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** The multipart file as handed over by FileInterceptor (memory storage). */
export interface UploadedPdfFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** POST .../invoice-documents/:documentId/confirm response (plan §7.7). */
export interface ConfirmInvoiceDocumentResponse {
  documentId: string;
  /** The Draft invoice created at confirm (never Active — BRD 4.1). */
  invoice: {
    id: string;
    customerId: string;
    contactId: string | null;
    invoiceNumber: string;
    amountMinorUnits: number;
    currency: string;
    issueDate: Date;
    dueDate: Date;
    status: string;
  };
  /** Suppression re-check outcome (BRD hard rule; the 1.3 §7.4 parity): the
   *  invoice still lands as Draft — enforcement is at send time (1.5/1.7). */
  suppressed: boolean;
}

type InvoiceDocumentRecord = Prisma.InvoiceDocumentGetPayload<object>;

/** The persisted extracted_fields jsonb shape (plan §3 — see @eva/types). */
interface StoredExtraction {
  fields: Partial<Record<ExtractableField, ExtractedFieldValue>>;
  notes: string[];
}

const DEFAULT_TIMEZONE = "Europe/London";

@Injectable()
export class InvoiceDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    @Inject(EXTRACTION_PROVIDER) private readonly extractionProvider: ExtractionProvider,
  ) {}

  /**
   * Stages an uploaded single-invoice PDF (plan §3) and extracts it
   * SYNCHRONOUSLY in the same request (plan §7.1): magic-byte sniffed
   * (%PDF- — extensions/MIME are never trusted, BRD 15), malware-scan seam,
   * then the extraction provider. The PDF itself IS persisted (plan §7.2) —
   * review needs source-beside-fields and 1.7 needs the attachment. Upload
   * never triggers any customer communication (BRD 4.1). imports:write.
   */
  async upload(
    authUser: AuthUser,
    organisationId: string,
    file: UploadedPdfFile,
  ): Promise<InvoiceDocumentDetail> {
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new PayloadTooLargeException("Invoice documents are limited to 10 MB");
    }
    scanUpload(file.buffer);
    sniffPdf(file.buffer);

    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:write");
      const document = await tx.invoiceDocument.create({
        data: {
          organisationId,
          originalFilename: file.originalname,
          sizeBytes: file.size,
          // The generated client types bytea as Uint8Array<ArrayBuffer>;
          // re-view the multer Buffer to satisfy the generic.
          content: new Uint8Array(file.buffer),
          createdBy: user.id,
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice_document.uploaded",
        entityType: "invoice_document",
        entityId: document.id,
        // Counts/sizes only — never document content or amounts (BRD 14).
        metadata: { sizeBytes: file.size },
      });
      return this.runExtraction(tx, organisationId, user.id, document.id);
    });
  }

  /** Lists the org's invoice documents, newest first — imports:read. The PDF
   *  bytes are never included in JSON responses (only the file endpoint). */
  async list(authUser: AuthUser, organisationId: string): Promise<InvoiceDocumentSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:read");
      const records = await tx.invoiceDocument.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return records.map((record) => this.toSummary(record));
    });
  }

  /** The review payload (plan §3): extracted values + per-field confidence +
   *  notes. imports:read. Cross-tenant/deleted ids are 404, never 403. */
  async getById(
    authUser: AuthUser,
    organisationId: string,
    documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:read");
      return this.toDetail(await this.findOrThrow(tx, documentId));
    });
  }

  /** The stored PDF itself (plan §7.2): review shows source beside fields,
   *  and the user reads from it when entering manually. imports:read. */
  async getFile(
    authUser: AuthUser,
    organisationId: string,
    documentId: string,
  ): Promise<{ content: Buffer; filename: string }> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:read");
      const document = await this.findOrThrow(tx, documentId);
      return { content: Buffer.from(document.content), filename: document.originalFilename };
    });
  }

  /** Re-runs extraction (plan §3): the retry path after a failure, also
   *  allowed from `extracted`. imports:write. */
  async extract(
    authUser: AuthUser,
    organisationId: string,
    documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:write");
      await this.findOrThrow(tx, documentId);
      return this.runExtraction(tx, organisationId, user.id, documentId);
    });
  }

  /**
   * The hybrid heart (plan §7.7): the body is ALWAYS the complete, final,
   * human-reviewed field set — pre-filled from extraction and corrected, or
   * entered fully manually after a failure (confirm is allowed from
   * `extracted` AND `failed`). Creates the invoice as DRAFT (never Active —
   * BRD 4.1), resolves/creates the customer + contact via the shared 1.3
   * logic (reference → name → create; ambiguous → 400), re-checks suppression
   * (flag in the response; the invoice still lands), links the document and
   * moves it to `confirmed`. imports:write.
   */
  async confirm(
    authUser: AuthUser,
    organisationId: string,
    documentId: string,
    body: ConfirmInvoiceDocumentRequest,
  ): Promise<ConfirmInvoiceDocumentResponse> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:write");
      const document = await this.findOrThrow(tx, documentId);
      // 409 from confirmed/uploaded; the whole transaction rolls back if any
      // later step fails, so the status write is safe to do first.
      await transitionInvoiceDocumentStatus(tx, documentId, document.status, "confirm");

      const existingNumbers = await listLiveInvoiceNumbers(tx);
      if (existingNumbers.has(body.invoiceNumber)) {
        throw new ConflictException(
          `Invoice number '${body.invoiceNumber}' is already in use in this organisation`,
        );
      }

      const canonical = confirmCanonical(body);
      const resolution = resolveCustomer(canonical, await listLiveCustomers(tx));
      if (resolution.kind === "ambiguous") {
        throw new BadRequestException(
          `customer match is ambiguous (${resolution.matches} live customers match) — use a unique customerReference`,
        );
      }
      let customerId: string;
      let customerCreated = false;
      if (resolution.kind === "matched") {
        customerId = resolution.customerId;
      } else {
        const created = await createCustomerFromCanonical(tx, organisationId, user.id, canonical);
        customerId = created.id;
        customerCreated = true;
      }
      const contactId = await resolveOrCreateContact(
        tx,
        organisationId,
        user.id,
        customerId,
        canonical,
      );

      // Suppression re-check (BRD hard rule — every import path re-checks).
      const suppressed =
        (await this.emailSuppressed(tx, organisationId, body.contactEmail)) ||
        (await this.emailSuppressed(tx, organisationId, body.customerEmail));

      const timezone = await this.orgTimezone(tx, organisationId);
      const invoice = await this.createInvoice(tx, organisationId, user.id, timezone, {
        customerId,
        contactId,
        body,
      });

      await tx.invoiceDocument.update({
        where: { id: documentId },
        data: { invoiceId: invoice.id },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice_document.confirmed",
        entityType: "invoice_document",
        entityId: documentId,
        // Flags only — never amounts or document content (BRD 14).
        metadata: { suppressed, customerCreated },
      });
      return {
        documentId,
        invoice: {
          id: invoice.id,
          customerId: invoice.customerId,
          contactId: invoice.contactId,
          invoiceNumber: invoice.invoiceNumber,
          amountMinorUnits: invoice.amountMinorUnits,
          currency: invoice.currency,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          status: invoice.status,
        },
        suppressed,
      };
    });
  }

  /** Discards a staged extraction (plan §3 — the 1.3 cancel pattern). Cancel
   *  is a SOFT DELETE (the 0008 CHECK has no 'cancelled' status): subsequent
   *  access is 404. Confirmed documents cannot be cancelled. imports:write. */
  async cancel(
    authUser: AuthUser,
    organisationId: string,
    documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:write");
      const document = await this.findOrThrow(tx, documentId);
      if (document.status === "confirmed") {
        throw new ConflictException("Invoice document cannot 'cancel' from status 'confirmed'");
      }
      await tx.invoiceDocument.update({
        where: { id: documentId },
        data: { deletedAt: new Date() },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice_document.cancelled",
        entityType: "invoice_document",
        entityId: documentId,
      });
      return this.toDetail(
        await tx.invoiceDocument.findUniqueOrThrow({ where: { id: documentId } }),
      );
    });
  }

  /** Runs the provider and lands the outcome: `extracted` with the field
   *  draft, or `failed` with a sanitised, actionable extraction_error (plan
   *  §8) — the manual-entry confirm path stays available either way. */
  private async runExtraction(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    const document = await tx.invoiceDocument.findUniqueOrThrow({ where: { id: documentId } });
    try {
      const result: ExtractionResult = await this.extractionProvider.extract({
        content: Buffer.from(document.content),
        filename: document.originalFilename,
      });
      const stored: StoredExtraction = { fields: result.fields, notes: result.notes };
      await transitionInvoiceDocumentStatus(tx, documentId, document.status, "extracted");
      await tx.invoiceDocument.update({
        where: { id: documentId },
        data: {
          extractedFields: stored as unknown as Prisma.InputJsonValue,
          extractionError: null,
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: userId,
        action: "invoice_document.extracted",
        entityType: "invoice_document",
        entityId: documentId,
        // Counts only — never extracted personal data or content (BRD 14).
        metadata: { fieldsExtracted: Object.keys(result.fields).length },
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      // Sanitised, actionable reason only — never raw extractor internals
      // (plan §8); NoTextLayerError carries the scanned-document guidance.
      const reason =
        error instanceof NoTextLayerError
          ? error.message
          : "the file could not be read as a PDF — check it opens correctly and try again";
      await transitionInvoiceDocumentStatus(tx, documentId, document.status, "failed");
      await tx.invoiceDocument.update({
        where: { id: documentId },
        data: { extractedFields: Prisma.JsonNull, extractionError: reason },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: userId,
        action: "invoice_document.extraction_failed",
        entityType: "invoice_document",
        entityId: documentId,
        metadata: { reason },
      });
    }
    return this.toDetail(await tx.invoiceDocument.findUniqueOrThrow({ where: { id: documentId } }));
  }

  /** Creates the DRAFT invoice via the shared ledger helper; the 0006 partial
   *  unique index is the duplicate backstop (P2002 → 409). */
  private async createInvoice(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    timezone: string,
    input: { customerId: string; contactId: string | null; body: ConfirmInvoiceDocumentRequest },
  ) {
    const { body } = input;
    try {
      return await createDraftInvoice(tx, organisationId, userId, timezone, {
        customerId: input.customerId,
        contactId: input.contactId,
        values: {
          invoiceNumber: body.invoiceNumber,
          amountMinorUnits: body.amountMinorUnits,
          currency: body.currency,
          ...(body.issueDate !== undefined
            ? { issueDate: parseImportDate(body.issueDate) ?? todayInTimezone(timezone) }
            : {}),
          // zod guarantees an ISO date; parseImportDate accepts it (1.3 semantics).
          dueDate: parseImportDate(body.dueDate)!,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          `Invoice number '${body.invoiceNumber}' is already in use in this organisation`,
        );
      }
      throw error;
    }
  }

  private async emailSuppressed(
    tx: TenantTx,
    organisationId: string,
    email: string | undefined,
  ): Promise<boolean> {
    if (email === undefined) return false;
    return isSuppressed(tx, organisationId, "email", normaliseSuppressionValue("email", email));
  }

  /** The org's business timezone (BRD 18.1); default Europe/London. */
  private async orgTimezone(tx: TenantTx, organisationId: string): Promise<string> {
    const settings = await tx.organisationSettings.findUnique({ where: { organisationId } });
    return settings?.timezone ?? DEFAULT_TIMEZONE;
  }

  /** Finds a live document inside the active tenant — 404, never 403 (BRD 15). */
  private async findOrThrow(tx: TenantTx, documentId: string): Promise<InvoiceDocumentRecord> {
    const document = await tx.invoiceDocument.findFirst({
      where: { id: documentId, deletedAt: null },
    });
    if (!document) throw new NotFoundException("Invoice document not found");
    return document;
  }

  private toSummary(record: InvoiceDocumentRecord): InvoiceDocumentSummary {
    return {
      id: record.id,
      originalFilename: record.originalFilename,
      sizeBytes: record.sizeBytes,
      status: record.status as InvoiceDocumentSummary["status"],
      extractionError: record.extractionError,
      invoiceId: record.invoiceId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toDetail(record: InvoiceDocumentRecord): InvoiceDocumentDetail {
    const stored = record.extractedFields as StoredExtraction | null;
    return {
      ...this.toSummary(record),
      extractedFields: stored?.fields ?? null,
      extractionNotes: stored?.notes ?? [],
    };
  }
}

/** Extensions/MIME are never trusted (BRD 15): the magic bytes decide. */
function sniffPdf(buffer: Buffer): void {
  const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  const isPdf = PDF_MAGIC.every((byte, index) => buffer.length > index && buffer[index] === byte);
  if (!isPdf) {
    throw new UnprocessableEntityException("The file is not a PDF");
  }
}

/** Projects the confirm body onto the canonical-row shape the shared ledger
 *  helpers resolve customers/contacts from. */
function confirmCanonical(body: ConfirmInvoiceDocumentRequest): CanonicalRow {
  const canonical: CanonicalRow = {};
  if (body.customerReference !== undefined) canonical.customerReference = body.customerReference;
  if (body.customerName !== undefined) canonical.customerName = body.customerName;
  if (body.customerEmail !== undefined) canonical.customerEmail = body.customerEmail;
  if (body.contactName !== undefined) canonical.contactName = body.contactName;
  if (body.contactEmail !== undefined) canonical.contactEmail = body.contactEmail;
  return canonical;
}
