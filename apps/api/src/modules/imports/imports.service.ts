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
import type { ImportDetail, ImportRowView, ImportSummary } from "@eva/types";
import {
  importMappingSchema,
  importRowSchema,
  type ImportCanonicalField,
  type ImportMapping,
} from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import { isSuppressed, normaliseSuppressionValue } from "../../common/suppression/suppression.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { todayInTimezone } from "../invoices/invoice-status.js";
import {
  MAX_IMPORT_ROWS,
  MAX_UPLOAD_BYTES,
  parseImportFile,
  scanUpload,
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

type CanonicalRow = Partial<Record<ImportCanonicalField, string>>;

/** Semantic invoice values parsed from a canonical row (BRD 10 minor units). */
interface ParsedValues {
  invoiceNumber: string;
  amountMinorUnits: number;
  currency: string;
  issueDate?: Date;
  dueDate: Date;
}

interface CustomerMatch {
  id: string;
  name: string;
  reference: string | null;
}

type CustomerResolution =
  | { kind: "matched"; customerId: string }
  | { kind: "ambiguous"; matches: number }
  | { kind: "create" };

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
      const customers = await this.liveCustomers(tx);
      const existingNumbers = await this.liveInvoiceNumbers(tx);

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
   */
  async confirm(
    authUser: AuthUser,
    organisationId: string,
    importId: string,
  ): Promise<ImportDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    try {
      return await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
        await requirePermission(tx, organisationId, user.id, "imports:write");
        const importRecord = await this.findOrThrow(tx, importId);
        this.requireUploaded(importRecord, "confirm");
        const mapping = importRecord.mapping as ImportMapping;
        const timezone = await this.orgTimezone(tx, organisationId);
        const customers = await this.liveCustomers(tx);
        const existingNumbers = await this.liveInvoiceNumbers(tx);
        const stagedRows = await tx.importRow.findMany({
          where: { importId },
          orderBy: { rowNumber: "asc" },
        });

        let createdRows = 0;
        let customersCreated = 0;
        for (const row of stagedRows) {
          if (row.status !== "valid" && row.status !== "suppressed") continue;
          const raw = row.raw as Record<string, string>;
          const canonical = canonicalise(raw, mapping);
          const analysis = analyseRow(canonical);
          const notes = (row.errors as string[]).filter(
            (message) => !message.endsWith("will be created on confirm"),
          );
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

  /** Auto-creates an unmatched customer (plan §7.2); never updates existing rows. */
  private async createCustomer(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    canonical: CanonicalRow,
  ) {
    return tx.customer.create({
      data: {
        organisationId,
        name: (canonical.customerName ?? canonical.customerReference)!,
        email: canonical.customerEmail?.toLowerCase() ?? null,
        reference: canonical.customerReference ?? null,
        createdBy: userId,
      },
    });
  }

  /** Creates a contact when contact fields are present, reusing a live contact
   *  with the same normalised email on that customer (never duplicates). */
  private async resolveOrCreateContact(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    customerId: string,
    canonical: CanonicalRow,
  ): Promise<string | null> {
    if (canonical.contactName === undefined && canonical.contactEmail === undefined) return null;
    const email = canonical.contactEmail?.toLowerCase() ?? null;
    if (email !== null) {
      const existing = await tx.contact.findFirst({
        where: { customerId, deletedAt: null, email },
      });
      if (existing) return existing.id;
    }
    const contact = await tx.contact.create({
      data: {
        organisationId,
        customerId,
        name: canonical.contactName ?? email!,
        email,
        createdBy: userId,
      },
    });
    return contact.id;
  }

  /** Creates the DRAFT invoice for an importable row (plan §7.7) — the same
   *  creation semantics as 1.2: integer minor units, currency, issueDate
   *  defaulting to the creation day in the org timezone (BRD 18.1). */
  private async createImportedInvoice(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    timezone: string,
    input: { customerId: string; contactId: string | null; values: ParsedValues },
  ) {
    return tx.invoice.create({
      data: {
        organisationId,
        customerId: input.customerId,
        contactId: input.contactId,
        invoiceNumber: input.values.invoiceNumber,
        amountMinorUnits: input.values.amountMinorUnits,
        currency: input.values.currency,
        issueDate: input.values.issueDate ?? todayInTimezone(timezone),
        dueDate: input.values.dueDate,
        status: "draft",
        createdBy: userId,
      },
    });
  }

  private async liveCustomers(tx: TenantTx): Promise<CustomerMatch[]> {
    return tx.customer.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, reference: true },
    });
  }

  /** Live invoice numbers only — a soft-deleted number is reusable (0006 index). */
  private async liveInvoiceNumbers(tx: TenantTx): Promise<Set<string>> {
    const invoices = await tx.invoice.findMany({
      where: { deletedAt: null },
      select: { invoiceNumber: true },
    });
    return new Set(invoices.map((invoice) => invoice.invoiceNumber));
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
  const amountMinorUnits = parseImportAmount(row.amount);
  if (amountMinorUnits === null) {
    errors.push(`amount '${row.amount}' is not a valid positive amount`);
  }
  const currency = normaliseImportCurrency(row.currency);
  if (currency === null) {
    errors.push(`currency '${row.currency}' must be a 3-letter ISO 4217 code`);
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

/** Customer pre-resolution (plan §7.2): live customer by reference, else by
 *  case-insensitive exact name; multiple matches are errors, never guesses. */
function resolveCustomer(canonical: CanonicalRow, customers: CustomerMatch[]): CustomerResolution {
  if (canonical.customerReference !== undefined) {
    const matches = customers.filter((c) => c.reference === canonical.customerReference);
    if (matches.length === 1) return { kind: "matched", customerId: matches[0]!.id };
    if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
  }
  if (canonical.customerName !== undefined) {
    const wanted = canonical.customerName.toLowerCase();
    const matches = customers.filter((c) => c.name.toLowerCase() === wanted);
    if (matches.length === 1) return { kind: "matched", customerId: matches[0]!.id };
    if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
  }
  return { kind: "create" };
}

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
