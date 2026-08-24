import { UnprocessableEntityException } from "@nestjs/common";
import { parse as parseCsvRecords } from "csv-parse/sync";
import ExcelJS from "exceljs";
import type { ImportFileType } from "@eva/types";

/**
 * Upload parsing + security (BRD 15 — the platform's FIRST upload surface;
 * Slice 1.3 plan §3). Files are held in memory, parsed and discarded — never
 * written to disk or object storage (BRD 16 data minimisation). Extensions
 * and MIME types are never trusted: the type is sniffed from magic bytes.
 * Both libraries are isolated behind this adapter (plan §7.5) so either is
 * swappable without route changes. The malware-scan seam lives in
 * common/upload (Slice 1.4 — shared with the PDF upload surface).
 */

/** 1,000 data-row cap (plan §3) — imports run synchronously (plan §7.8). */
export const MAX_IMPORT_ROWS = 1_000;

export interface ParsedImportFile {
  headers: string[];
  /** One entry per data row: file column name → raw string value. */
  rows: Record<string, string>[];
}

/** XLSX is a ZIP archive (PK\x03\x04). */
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Legacy .xls is an OLE2 compound document (BIFF) — rejected (plan §3). */
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function hasMagic(buffer: Buffer, magic: readonly number[]): boolean {
  return magic.every((byte, index) => buffer.length > index && buffer[index] === byte);
}

/**
 * Determines the real file type from magic bytes — never from the filename
 * or MIME type (BRD 15). CSV must be valid UTF-8 text with no NUL bytes.
 */
export function sniffFileType(buffer: Buffer): ImportFileType {
  if (hasMagic(buffer, XLS_MAGIC)) {
    throw new UnprocessableEntityException(
      "Legacy .xls files are not supported — save the file as .xlsx or .csv",
    );
  }
  if (hasMagic(buffer, XLSX_MAGIC)) return "xlsx";
  if (buffer.includes(0x00)) {
    throw new UnprocessableEntityException("The file is not a valid UTF-8 text CSV");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new UnprocessableEntityException("The file is not a valid UTF-8 text CSV");
  }
  return "csv";
}

/** Parses an upload buffer into headers + raw string rows (plan §3). */
export async function parseImportFile(
  buffer: Buffer,
  fileType: ImportFileType,
): Promise<ParsedImportFile> {
  return fileType === "xlsx" ? parseXlsx(buffer) : parseCsv(buffer);
}

/** CSV: UTF-8/BOM, quoted fields, CRLF, ragged rows tolerated (plan §6). */
function parseCsv(buffer: Buffer): ParsedImportFile {
  let records: string[][];
  try {
    records = parseCsvRecords(buffer.toString("utf8"), {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch {
    throw new UnprocessableEntityException("The file could not be parsed as CSV");
  }
  return toHeadersAndRows(records);
}

/** XLSX: first worksheet, first row = headers, cell values → trimmed strings. */
async function parseXlsx(buffer: Buffer): Promise<ParsedImportFile> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs types its load() against an older Buffer generic — the runtime
    // accepts any Buffer/Uint8Array.
    await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0]);
  } catch {
    throw new UnprocessableEntityException("The file could not be parsed as XLSX");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new UnprocessableEntityException("The workbook has no worksheets");
  }
  const columnCount = sheet.actualColumnCount;
  const records: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let column = 1; column <= columnCount; column++) {
      values.push(cellToString(row.getCell(column).value));
    }
    records.push(values);
  });
  return toHeadersAndRows(records);
}

/** Flattens an exceljs cell value to a trimmed string (dates → YYYY-MM-DD). */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) {
      return value.richText
        .map((part) => part.text)
        .join("")
        .trim();
    }
    if ("result" in value && value.result !== undefined) {
      return cellToString(value.result as ExcelJS.CellValue);
    }
    if ("text" in value) return String(value.text).trim();
    if ("error" in value) return "";
  }
  return String(value).trim();
}

function toHeadersAndRows(records: string[][]): ParsedImportFile {
  const [headerRow, ...dataRows] = records;
  if (!headerRow || headerRow.every((cell) => cell.trim() === "")) {
    throw new UnprocessableEntityException("The file has no header row");
  }
  const headers = headerRow.map((header) => header.trim());
  const rows = dataRows
    .filter((record) => record.some((cell) => cell.trim() !== ""))
    .map((record) =>
      Object.fromEntries(headers.map((header, index) => [header, (record[index] ?? "").trim()])),
    );
  return { headers, rows };
}
