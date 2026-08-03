import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { withTenant } from "@eva/database";
import type { Prisma } from "@eva/database";
import {
  minorUnitDigits,
  type ImportDetail,
  type ImportRowView,
  type ImportSummary,
} from "@eva/types";
import {
  importMappingSchema,
  importRowSchema,
  type ConfirmImportRequest,
  type ImportMapping,
  type ImportRowCorrections,
} from "@eva/validation";
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
  type ParsedInvoiceValues,
} from "../../common/ledger/ledger.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import {
  MAX_IMPORT_ROWS,
  MAX_UPLOAD_BYTES,
  parseImportFile,
  sniffFileType,
} from "./import-parser.js";
import { autoMapHeaders } from "./import-mapping.js";
import { normaliseImportCurrency, parseImportAmount, parseImportDate } from "./import-values.js";
import { transitionImportStatus } from "./import-status-machine.js";

/** The multipart file as handed over by FileInterceptor (memory storage). */
export interface UploadedImportFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

type ImportRecord = Prisma.ImportGetPayload<object>;
type ImportRowRecord = Prisma.ImportRowGetPayload<object>;

/** Semantic invoice values parsed from a canonical row (BRD 10 minor units). */
type ParsedValues = ParsedInvoiceValues;

const DEFAULT_TIMEZONE = "Europe/London";

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Stages an upload (plan §7.1 — persisted two-phase import): sniffs the
   * real type (BRD 15), parses, validates every row, detects duplicates,
   * re-checks suppression (BRD hard rule) and pre-resolves customers — then
   * persists import + staged rows in ONE transaction. The file itself is
   * discarded (BRD 16). imports:write.
   */
  async upload(
    authUser: AuthUser,
    organisationId: string,
    file: UploadedImportFile,
    mappingJson?: string,
  ): Promise<ImportDetail> {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException("Import files are limited to 5 MB");
    }
    scanUpload(file.buffer);
    const fileType = sniffFileType(file.buffer);
    const { headers, rows } = await parseImportFile(file.buffer, fileType);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new UnprocessableEntityException(
        `Import files are limited to ${MAX_IMPORT_ROWS} data rows (got ${rows.length})`,
      );
    }
    const mapping = this.resolveMapping(mappingJson, headers);

    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:write");
      const customers = await listLiveCustomers(tx);
      const existingNumbers = await listLiveInvoiceNumbers(tx);

      const seenInFile = new Set<string>();
      const staged: {
        rowNumber: number;
        raw: Record<string, string>;
        status: string;
        errors: string[];
      }[] = [];
      for (const [index, raw] of rows.entries()) {
        const canonical = canonicalise(raw, mapping);
        const analysis = analyseRow(canonical);
        const errors = [...analysis.errors];

        let status: string;
        if (errors.length > 0) {
          status = "invalid";
        } else if (seenInFile.has(analysis.values!.invoiceNumber)) {
          // Within-file duplicates: the first occurrence stands (plan §7.3).
          status = "skipped";
        } else if (existingNumbers.has(analysis.values!.invoiceNumber)) {
          // Already live in the org — never upserted (plan §7.3).
          status = "duplicate";
        } else {
          const resolution = resolveCustomer(canonical, customers);
          if (resolution.kind === "ambiguous") {
            errors.push(
              `customer match is ambiguous (${resolution.matches} live customers match) — fix the ledger or use a unique reference`,
            );
            status = "invalid";
          } else {
            // Suppression re-check (BRD hard rule — every import re-checks);
            // suppressed rows still import as Draft + flag (plan §7.4).
            const suppressed =
              (await this.emailSuppressed(tx, organisationId, canonical.contactEmail)) ||
              (await this.emailSuppressed(tx, organisationId, canonical.customerEmail));
            status = suppressed ? "suppressed" : "valid";
            if (resolution.kind === "create") {
              // Auto-created customers are flagged in preview + report (plan §7.2).
              errors.push(
                `customer '${canonical.customerName ?? canonical.customerReference}' will be created on confirm`,
              );
            }
          }
        }
        seenInFile.add(analysis.values?.invoiceNumber ?? `row-${index}`);
        staged.push({ rowNumber: index + 1, raw, status, errors });
      }

      const counts = countStatuses(staged);
      const importRecord = await tx.import.create({
        data: {
          organisationId,
          originalFilename: file.originalname,
          fileType,
          mapping: mapping as Prisma.InputJsonValue,
          totalRows: staged.length,
          ...counts,
          createdRows: 0,
          createdBy: user.id,
        },
      });
      await tx.importRow.createMany({
        data: staged.map((row) => ({
          organisationId,
          importId: importRecord.id,
          rowNumber: row.rowNumber,
          raw: row.raw as Prisma.InputJsonValue,
          status: row.status,
          errors: row.errors as Prisma.InputJsonValue,
          createdBy: user.id,
        })),
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "import.uploaded",
        entityType: "import",
        entityId: importRecord.id,
        // Counts only — never amounts or customer financial detail (BRD 14).
        metadata: { fileType, totalRows: staged.length, ...counts },
      });
      const storedRows = await tx.importRow.findMany({
        where: { importId: importRecord.id },
        orderBy: { rowNumber: "asc" },
      });
      return this.toDetail(importRecord, storedRows);
    });
  }

  /** Lists the org's imports, newest first (report history) — imports:read. */
  async list(authUser: AuthUser, organisationId: string): Promise<ImportSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:read");
      const records = await tx.import.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return records.map((record) => this.toSummary(record));
    });
  }

  /** Reads one import with its staged rows — preview before confirm, report
   *  after (plan §3). imports:read. Cross-tenant/deleted ids are 404. */
  async getById(
    authUser: AuthUser,
    organisationId: string,
    importId: string,
  ): Promise<ImportDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:read");
      const importRecord = await this.findOrThrow(tx, importId);
      const rows = await tx.importRow.findMany({
        where: { importId },
        orderBy: { rowNumber: "asc" },
      });
      return this.toDetail(importRecord, rows);
    });
  }

  /**
   * Executes the import synchronously in ONE transaction (plan §7.8):
   * resolves or creates customers (+ optional contacts, plan §7.2), creates
   * every importable row as a DRAFT invoice (plan §7.7 — activation stays a
   * per-invoice human action, BRD 4.1), updates counts and marks the import
   * completed. Duplicates and invalid rows are skipped, never upserted
   * (plan §7.3). Any unexpected error rolls the whole transaction back: the
   * import is marked failed and zero rows land (plan §8 risk 3).
   * Optional per-row corrections (Slice 1.4 plan §7.9) are merged over the
   * staged raw values and re-validated BEFORE the row is processed: a
   * corrected-invalid row becomes importable; a correction making the number
   * duplicate a live invoice is skipped as `duplicate`; a still-invalid
   * corrected row stays invalid with the new errors. Rows without a
   * correction behave exactly as before.
   */
  async confirm(
    authUser: AuthUser,
    organisationId: string,
    importId: string,
    request?: ConfirmImportRequest,
  ): Promise<ImportDetail> {
    const corrections = request?.corrections;
    const user = await this.usersService.resolveOrProvision(authUser);
    try {
      return await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
        await requirePermission(tx, organisationId, user.id, "imports:write");
        const importRecord = await this.findOrThrow(tx, importId);
        this.requireUploaded(importRecord, "confirm");
        const mapping = importRecord.mapping as ImportMapping;
        const timezone = await this.orgTimezone(tx, organisationId);
        const customers = await listLiveCustomers(tx);
        const existingNumbers = await listLiveInvoiceNumbers(tx);
        const stagedRows = await tx.importRow.findMany({
          where: { importId },
          orderBy: { rowNumber: "asc" },
        });

        let createdRows = 0;
        let customersCreated = 0;
        let correctionsApplied = 0;
        for (const row of stagedRows) {
          const correction = corrections?.[row.rowNumber];
          const importable = row.status === "valid" || row.status === "suppressed";
          // Non-importable rows stay untouched UNLESS a correction re-opens
          // them (plan §7.9 — the review-fix-save parity with PDFs).
          if (!importable && correction === undefined) continue;
          if (correction !== undefined) correctionsApplied++;
          const raw = row.raw as Record<string, string>;
          const canonical = applyCorrection(canonicalise(raw, mapping), correction);
          const analysis = analyseRow(canonical);
          const notes = importable
            ? (row.errors as string[]).filter(
                (message) => !message.endsWith("will be created on confirm"),
              )
            : // A re-opened invalid row's staged errors are stale — replaced by
              // the re-validation outcome below.
              [];
          if (!analysis.values) {
            await tx.importRow.update({
              where: { id: row.id },
              data: { status: "invalid", errors: analysis.errors as Prisma.InputJsonValue },
            });
            continue;
          }
          if (existingNumbers.has(analysis.values.invoiceNumber)) {
            // Became a duplicate between staging and confirm — skipped, never
            // upserted (plan §7.3); the 0006 partial unique index is the backstop.
            await tx.importRow.update({ where: { id: row.id }, data: { status: "duplicate" } });
            continue;
          }
          const resolution = resolveCustomer(canonical, customers);
          if (resolution.kind === "ambiguous") {
            await tx.importRow.update({
              where: { id: row.id },
              data: {
                status: "invalid",
                errors: [
                  `customer match is ambiguous (${resolution.matches} live customers match) — fix the ledger or use a unique reference`,
                ] as Prisma.InputJsonValue,
              },
            });
            continue;
          }

          let customerId: string;
          if (resolution.kind === "matched") {
            customerId = resolution.customerId;
          } else {
            const created = await this.createCustomer(tx, organisationId, user.id, canonical);
            customers.push({ id: created.id, name: created.name, reference: created.reference });
            customerId = created.id;
            customersCreated++;
            notes.push(`customer '${created.name}' was created by this import`);
          }
          const contactId = await this.resolveOrCreateContact(
            tx,
            organisationId,
            user.id,
            customerId,
            canonical,
          );
          const invoice = await this.createImportedInvoice(tx, organisationId, user.id, timezone, {
            customerId,
            contactId,
            values: analysis.values,
          });
          existingNumbers.add(analysis.values.invoiceNumber);
          createdRows++;
          await tx.importRow.update({
            where: { id: row.id },
            data: {
              // Suppressed rows KEEP their flag (plan §7.4) — enforcement is
              // at send time (1.5/1.7); the invoice link shows they imported.
              status: row.status === "suppressed" ? "suppressed" : "imported",
              createdInvoiceId: invoice.id,
              errors: notes as Prisma.InputJsonValue,
            },
          });
        }

        const finalRows = await tx.importRow.findMany({
          where: { importId },
          orderBy: { rowNumber: "asc" },
        });
        const counts = countStatuses(finalRows.map((row) => ({ status: row.status })));
        await tx.import.update({
          where: { id: importId },
          data: { ...counts, createdRows },
        });
        await transitionImportStatus(tx, importId, importRecord.status, "confirm");
        await writeAuditLog(tx, {
          organisationId,
          actorUserId: user.id,
          action: "import.completed",
          entityType: "import",
          entityId: importId,
          // Counts only — never amounts or customer financial detail (BRD 14).
          metadata: {
            totalRows: finalRows.length,
            ...counts,
            createdRows,
            customersCreated,
            correctionsApplied,
          },
        });
        const completed = await tx.import.findUniqueOrThrow({ where: { id: importId } });
        return this.toDetail(completed, finalRows);
      });
    } catch (error) {
      // Expected client errors (403/404/409) never mark the import failed.
      if (error instanceof HttpException) throw error;
      await this.markFailed(user.id, organisationId, importId);
      throw new InternalServerErrorException("Import failed — no rows were applied");
    }
  }

  /** Cancels a staged import (wrong mapping → cancel + re-upload, plan §3).
   *  Only `uploaded` imports can be cancelled — else 409. imports:write. */
  async cancel(
    authUser: AuthUser,
    organisationId: string,
    importId: string,
  ): Promise<ImportDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "imports:write");
      const importRecord = await this.findOrThrow(tx, importId);
      await transitionImportStatus(tx, importId, importRecord.status, "cancel");
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "import.cancelled",
        entityType: "import",
        entityId: importId,
      });
      const cancelled = await tx.import.findUniqueOrThrow({ where: { id: importId } });
      const rows = await tx.importRow.findMany({
        where: { importId },
        orderBy: { rowNumber: "asc" },
      });
      return this.toDetail(cancelled, rows);
    });
  }

  /** Best-effort failure marking after a rolled-back confirm (plan §8 risk 3). */
  private async markFailed(
    userId: string,
    organisationId: string,
    importId: string,
  ): Promise<void> {
    try {
      await withTenant(this.prisma.db, { organisationId, userId }, async (tx) => {
        const importRecord = await tx.import.findFirst({
          where: { id: importId, deletedAt: null },
        });
        if (!importRecord || importRecord.status !== "uploaded") return;
        await transitionImportStatus(tx, importId, importRecord.status, "fail");
        await writeAuditLog(tx, {
          organisationId,
          actorUserId: userId,
          action: "import.failed",
          entityType: "import",
          entityId: importId,
        });
      });
    } catch {
      // Best effort — the original failure is what the caller sees.
    }
  }

  /** Provided mapping (JSON, validated) or header auto-mapping (plan §3). */
  private resolveMapping(mappingJson: string | undefined, headers: string[]): ImportMapping {
    if (mappingJson === undefined || mappingJson.trim() === "") {
      return autoMapHeaders(headers);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(mappingJson);
    } catch {
      throw new BadRequestException(
        "mapping must be a JSON object of file column → canonical field",
      );
    }
    const result = importMappingSchema.safeParse(parsed);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues[0]?.message ?? "mapping must map file columns to canonical fields",
      );
    }
    const mapping = result.data;
    const fields = Object.values(mapping);
    if (new Set(fields).size !== fields.length) {
      throw new BadRequestException("each canonical field can only be mapped once");
    }
    const unknown = Object.keys(mapping).filter((column) => !headers.includes(column));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `mapping references unknown file column(s): ${unknown.join(", ")}`,
      );
    }
    return mapping;
  }

  private requireUploaded(importRecord: ImportRecord, verb: string): void {
    if (importRecord.status !== "uploaded") {
      throw new ConflictException(`Import cannot '${verb}' from status '${importRecord.status}'`);
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

  /** Thin wrappers over the shared ledger helpers (common/ledger — the same
   *  code path the 1.4 PDF confirm uses); kept as methods so the module's
   *  seams (and specs) are unchanged. */
  private async createCustomer(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    canonical: CanonicalRow,
  ) {
    return createCustomerFromCanonical(tx, organisationId, userId, canonical);
  }

  private async resolveOrCreateContact(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    customerId: string,
    canonical: CanonicalRow,
  ): Promise<string | null> {
    return resolveOrCreateContact(tx, organisationId, userId, customerId, canonical);
  }

  private async createImportedInvoice(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    timezone: string,
    input: { customerId: string; contactId: string | null; values: ParsedValues },
  ) {
    return createDraftInvoice(tx, organisationId, userId, timezone, input);
  }

  /** The org's business timezone (BRD 18.1); default Europe/London. */
  private async orgTimezone(tx: TenantTx, organisationId: string): Promise<string> {
    const settings = await tx.organisationSettings.findUnique({ where: { organisationId } });
    return settings?.timezone ?? DEFAULT_TIMEZONE;
  }

  /** Finds a live import inside the active tenant — 404, never 403 (BRD 15). */
  private async findOrThrow(tx: TenantTx, importId: string): Promise<ImportRecord> {
    const importRecord = await tx.import.findFirst({ where: { id: importId, deletedAt: null } });
    if (!importRecord) throw new NotFoundException("Import not found");
    return importRecord;
  }

  private toSummary(record: ImportRecord): ImportSummary {
    return {
      id: record.id,
      originalFilename: record.originalFilename,
      fileType: record.fileType as ImportSummary["fileType"],
      status: record.status as ImportSummary["status"],
      mapping: record.mapping as Record<string, string>,
      totalRows: record.totalRows,
      validRows: record.validRows,
      invalidRows: record.invalidRows,
      duplicateRows: record.duplicateRows,
      suppressedRows: record.suppressedRows,
      createdRows: record.createdRows,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toRowView(row: ImportRowRecord): ImportRowView {
    return {
      id: row.id,
      rowNumber: row.rowNumber,
      raw: row.raw as Record<string, string>,
      status: row.status as ImportRowView["status"],
      errors: row.errors as string[],
      createdInvoiceId: row.createdInvoiceId,
    };
  }

  private toDetail(record: ImportRecord, rows: ImportRowRecord[]): ImportDetail {
    return { ...this.toSummary(record), rows: rows.map((row) => this.toRowView(row)) };
  }
}

/** Projects a raw file row through the resolved column mapping. */
function canonicalise(raw: Record<string, string>, mapping: ImportMapping): CanonicalRow {
  const canonical: CanonicalRow = {};
  for (const [column, field] of Object.entries(mapping)) {
    const value = raw[column];
    if (value !== undefined && value.trim() !== "") {
      canonical[field] = value.trim();
    }
  }
  return canonical;
}

/** Merges a per-row correction (Slice 1.4 plan §7.9) over the staged
 *  canonical values; empty correction cells mean "absent" — corrections
 *  overwrite, they never clear (the importRowSchema empty-cell rule). */
function applyCorrection(
  canonical: CanonicalRow,
  correction: ImportRowCorrections[number] | undefined,
): CanonicalRow {
  if (correction === undefined) return canonical;
  const merged: CanonicalRow = { ...canonical };
  for (const [field, value] of Object.entries(correction)) {
    if (value !== undefined) merged[field as keyof CanonicalRow] = value;
  }
  return merged;
}

/**
 * Shape (importRowSchema — shared with the web/worker, plan §3) + semantic
 * validation of one staged row. Returns per-row errors and, when clean, the
 * parsed invoice values.
 */
function analyseRow(canonical: CanonicalRow): { errors: string[]; values?: ParsedValues } {
  const shape = importRowSchema.safeParse(canonical);
  const errors = shape.success
    ? []
    : shape.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      );
  if (!shape.success) return { errors };

  const row = shape.data;
  /**
   * CURRENCY FIRST — the order matters (slice 1.6c).
   *
   * How many decimal places an amount may carry is a property of its currency:
   * 3 for KWD/BHD/OMR, 2 for GBP/AED/USD, 0 for JPY/VND. Parsing the amount
   * before reading the currency is how "12.345" came to be rejected as invalid
   * on a Kuwaiti invoice.
   */
  const currency = normaliseImportCurrency(row.currency);
  if (currency === null) {
    errors.push(`currency '${row.currency}' must be a 3-letter ISO 4217 code`);
  }
  const amountMinorUnits = currency === null ? null : parseImportAmount(row.amount, currency);
  if (amountMinorUnits === null && currency !== null) {
    errors.push(
      `amount '${row.amount}' is not a valid positive ${currency} amount` +
        ` (${currency} takes ${minorUnitDigits(currency)} decimal places)`,
    );
  }
  const dueDate = parseImportDate(row.dueDate);
  if (!dueDate) {
    errors.push(`dueDate '${row.dueDate}' is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)`);
  }
  let issueDate: Date | undefined;
  if (row.issueDate !== undefined) {
    const parsed = parseImportDate(row.issueDate);
    if (!parsed) {
      errors.push(
        `issueDate '${row.issueDate}' is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)`,
      );
    } else {
      issueDate = parsed;
    }
  }
  if (errors.length > 0 || amountMinorUnits === null || currency === null || !dueDate) {
    return { errors };
  }
  return {
    errors,
    values: {
      invoiceNumber: row.invoiceNumber,
      amountMinorUnits,
      currency,
      ...(issueDate !== undefined ? { issueDate } : {}),
      dueDate,
    },
  };
}

/** Customer pre-resolution lives in common/ledger (Slice 1.4 — shared with the
 *  PDF invoice-document confirm). */

function countStatuses(rows: { status: string }[]): {
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  suppressedRows: number;
} {
  return {
    // After confirm, imported rows were the valid ones (plan §7.7).
    validRows: rows.filter((r) => r.status === "valid" || r.status === "imported").length,
    invalidRows: rows.filter((r) => r.status === "invalid").length,
    duplicateRows: rows.filter((r) => r.status === "duplicate").length,
    suppressedRows: rows.filter((r) => r.status === "suppressed").length,
  };
}
