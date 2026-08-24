import type { ExtractableField, ExtractedFieldValue } from "@eva/types";

/**
 * Extraction-provider adapter (BRD §11; Slice 1.4 plan §3/§7.4): the
 * swappable seam between the invoice-documents module and whatever pulls
 * fields out of a PDF. The first implementation is rule-based (code-first
 * founder ruling — no AI provider, no external calls, no API keys); an AI
 * provider slots behind this same interface when a slice genuinely needs
 * language understanding, subject to founder decision then.
 */

/** DI token for the active extraction provider. */
export const EXTRACTION_PROVIDER = Symbol("EXTRACTION_PROVIDER");

export interface ExtractionInput {
  /** The PDF bytes (never logged — BRD 14). */
  content: Buffer;
  filename: string;
}

/** The extraction draft: per-field value + confidence, plus extractor notes
 *  (matches the invoice_documents.extracted_fields jsonb shape, plan §3). */
export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractedFieldValue>>;
  notes: string[];
}

export interface ExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

/** The PDF has no readable text layer — it is a scanned/photographed document.
 *  Mapped to a clear, actionable user message (manual-entry path, plan §8). */
export class NoTextLayerError extends Error {
  constructor() {
    super(
      "no readable text layer — this looks like a scanned document; enter the details manually",
    );
    this.name = "NoTextLayerError";
  }
}

/** The extractor itself failed (corrupt PDF, parser internals). The message
 *  shown to users is sanitised — internals only surface in server logs. */
export class ExtractionFailedError extends Error {
  constructor(cause?: unknown) {
    super("the file could not be read as a PDF — check it opens correctly and try again");
    this.name = "ExtractionFailedError";
    this.cause = cause;
  }
}

/**
 * A provider returned a result that does not match the stored-extraction shape.
 *
 * ⚠️ SEPARATE FROM `ExtractionFailedError` BECAUSE ITS MESSAGE WOULD LIE HERE.
 * That one tells the customer to check their file opens correctly — right when
 * the PDF is the one thing that behaved: it was read, and what came back was
 * malformed on OUR side. Sending someone to re-examine a file that is perfectly
 * fine is the kind of confidently wrong instruction this codebase keeps having
 * to delete.
 *
 * The port exists so an AI provider can slot in behind it (§7.4), and an
 * unreviewed provider returning a shape nobody validated is precisely what the
 * seam makes possible. The `cause` carries the validation detail for the server
 * log; the message stays sanitised (plan §8) and points at the manual-entry
 * path, which is the thing the customer can actually act on.
 */
export class MalformedExtractionError extends Error {
  constructor(cause?: unknown) {
    super("Eva could not read the details from this invoice — enter them below and confirm");
    this.name = "MalformedExtractionError";
    this.cause = cause;
  }
}
