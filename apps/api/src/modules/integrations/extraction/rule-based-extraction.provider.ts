import { Injectable } from "@nestjs/common";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ExtractableField, ExtractedFieldValue } from "@eva/types";
import { parseImportAmount, normaliseImportCurrency } from "../../../common/ledger/values.js";
import {
  ExtractionFailedError,
  NoTextLayerError,
  type ExtractionInput,
  type ExtractionProvider,
  type ExtractionResult,
} from "./extraction-provider.js";

/**
 * Rule-based extraction (Slice 1.4 plan §7.4 — the code-first founder
 * ruling): pdfjs-dist reads the PDF text layer, lines are reconstructed
 * (items grouped by y position, sorted by x), then labelled-field heuristics
 * find the ten canonical fields. No AI provider, no external calls, no API
 * keys — personal data never leaves the platform.
 *
 * Confidence is rule-derived (plan §3): an exact label with an adjacent
 * value → 0.9; a fuzzy match (value found without a label, e.g. the largest
 * amount on the page) → 0.5; a label found with no usable value → present
 * with value null and 0; a field never seen → absent from the result (the
 * review payload flags missing required fields; the human completes them at
 * confirm — the §7.7 hybrid ruling).
 */

/** Exact label + adjacent value. */
const LABEL_CONFIDENCE = 0.9;
/** Found without a label (fuzzy). */
const FUZZY_CONFIDENCE = 0.5;

const DATE_VALUE = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})`;
/** Currency-prefixed or plain decimal amount as written (e.g. "£1,234.56"). */
const AMOUNT_VALUE = String.raw`([£$€¥₹₩]?\s*\d[\d,]*(?:\.\d{1,2})?)`;
const EMAIL_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const INVOICE_NUMBER_LABEL =
  /\binvoice\s*(?:number|no\.?|num(?:ber)?|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{1,49})?/i;
const INVOICE_NUMBER_FUZZY = /\b(INV[-\s#]?\d[\w\-/]{0,48})\b/i;
const DUE_DATE_LABEL = new RegExp(
  String.raw`\b(?:payment\s+due(?:\s+date)?|due\s+date|date\s+due|due)\b\s*:?\s*` +
    `${DATE_VALUE}?`,
  "i",
);
const ISSUE_DATE_LABEL = new RegExp(
  String.raw`\b(?:invoice\s+date|issued?\s+date|date)\b\s*:?\s*` + `${DATE_VALUE}?`,
  "i",
);
const AMOUNT_LABEL = new RegExp(
  String.raw`\b(?:grand\s+total|total\s+due|amount\s+due|balance\s+due|total(?:\s+amount)?|amount)\b` +
    String.raw`\s*:?\s*` +
    `${AMOUNT_VALUE}?`,
  "i",
);
const AMOUNT_FUZZY = /[£$€¥₹₩]?\s*\d[\d,]*\.\d{2}\b/g;
const CURRENCY_LABEL = /\bcurrency\b\s*:?\s*([A-Za-z]{3})\b/i;
const CUSTOMER_NAME_LABEL =
  /\b(?:bill\s*to|invoice\s*to|sold\s*to|customer\s*name|customer)\b\s*:?\s*(.*)/i;
const CUSTOMER_REFERENCE_LABEL =
  /\bcustomer\s*(?:ref(?:erence)?|account(?:\s*(?:number|no))?|id)\b\s*:?\s*(\S+)/i;
const CONTACT_NAME_LABEL = /\b(?:attention|attn|contact(?:\s*name)?)\b\s*:?\s*(.*)/i;
const CUSTOMER_EMAIL_LABEL = /\b(?:customer|billing|accounts?)\s*e-?mail\b/i;
const CONTACT_EMAIL_LABEL = /\b(?:contact|attn|attention)\b/i;

/** Currency symbols mapped to ISO codes; anything else is unknown (noted). */
const CURRENCY_SYMBOLS: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };

type Fields = ExtractionResult["fields"];

@Injectable()
export class RuleBasedExtractionProvider implements ExtractionProvider {
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    let lines: string[];
    try {
      lines = await extractTextLines(input.content);
    } catch (error) {
      throw new ExtractionFailedError(error);
    }
    if (lines.join("\n").trim() === "") {
      // Scanned/photographed PDF (plan §8 risk 1) — the manual-entry confirm
      // path stays available from 'failed' (the §7.7 hybrid ruling).
      throw new NoTextLayerError();
    }

    const notes: string[] = [];
    const fields: Fields = {};
    this.extractInvoiceNumber(lines, fields, notes);
    this.extractDates(lines, fields);
    const amountRaw = this.extractAmount(lines, fields);
    this.extractCurrency(lines, amountRaw, fields, notes);
    this.extractParties(lines, fields);
    this.extractEmails(lines, fields);
    return { fields, notes };
  }

  /** Invoice number: label + same-line value; multiple distinct numbers mean
   *  a multi-invoice PDF — one invoice per PDF (plan §7.3), first wins + note. */
  private extractInvoiceNumber(lines: string[], fields: Fields, notes: string[]): void {
    const labelled: string[] = [];
    let labelWithoutValue = false;
    for (const line of lines) {
      const match = INVOICE_NUMBER_LABEL.exec(line);
      if (!match) continue;
      const value = match[1]?.trim();
      if (value) labelled.push(value);
      else labelWithoutValue = true;
    }
    const distinct = [...new Set(labelled)];
    if (distinct.length > 0) {
      put(fields, "invoiceNumber", distinct[0]!, LABEL_CONFIDENCE);
      if (distinct.length > 1 || (labelWithoutValue && distinct.length > 0)) {
        notes.push(
          "multiple invoice numbers detected — one invoice per PDF (plan §7.3); extracted the first",
        );
      }
      return;
    }
    for (const line of lines) {
      const fuzzy = INVOICE_NUMBER_FUZZY.exec(line);
      if (fuzzy?.[1]) {
        put(fields, "invoiceNumber", fuzzy[1].trim(), FUZZY_CONFIDENCE);
        return;
      }
    }
    if (labelWithoutValue) put(fields, "invoiceNumber", null, 0);
  }

  /** Dates: ISO (YYYY-MM-DD) and UK (DD/MM/YYYY) forms near date labels;
   *  dueDate prefers due/payment-due labels (plan §3). */
  private extractDates(lines: string[], fields: Fields): void {
    let dueLabelWithoutValue = false;
    let issueLabelWithoutValue = false;
    for (const line of lines) {
      if (fields.dueDate === undefined) {
        const due = DUE_DATE_LABEL.exec(line);
        if (due) {
          if (due[1]) put(fields, "dueDate", due[1], LABEL_CONFIDENCE);
          else dueLabelWithoutValue = true;
        }
      }
      if (fields.issueDate === undefined && !DUE_DATE_LABEL.test(line)) {
        const issue = ISSUE_DATE_LABEL.exec(line);
        if (issue) {
          if (issue[1]) put(fields, "issueDate", issue[1], LABEL_CONFIDENCE);
          else issueLabelWithoutValue = true;
        }
      }
    }
    // Fuzzy fallback: date forms found anywhere, dueDate first (unlabelled).
    const fuzzyDates = lines.flatMap((line) => {
      const found: string[] = [];
      for (const match of line.matchAll(new RegExp(DATE_VALUE, "g"))) {
        if (match[1]) found.push(match[1]);
      }
      return found;
    });
    if (fields.dueDate === undefined && fuzzyDates.length > 0) {
      put(fields, "dueDate", fuzzyDates[fuzzyDates.length - 1]!, FUZZY_CONFIDENCE);
    } else if (fields.dueDate === undefined && dueLabelWithoutValue) {
      put(fields, "dueDate", null, 0);
    }
    if (fields.issueDate === undefined && issueLabelWithoutValue) {
      put(fields, "issueDate", null, 0);
    }
  }

  /** Amount: currency amounts near total/amount-due/balance labels, largest
   *  wins (plan §3); without a label, the largest amount on the page (fuzzy). */
  private extractAmount(lines: string[], fields: Fields): string | undefined {
    let labelWithoutValue = false;
    const labelledCandidates: string[] = [];
    for (const line of lines) {
      const match = AMOUNT_LABEL.exec(line);
      if (!match) continue;
      const raw = match[1]?.trim();
      if (raw && parseAmount(raw) !== null) labelledCandidates.push(raw);
      else labelWithoutValue = true;
    }
    const labelled = largest(labelledCandidates);
    if (labelled !== undefined) {
      put(fields, "amount", labelled, LABEL_CONFIDENCE);
      return labelled;
    }
    const fuzzy = largest(
      lines.flatMap((line) => [...line.matchAll(AMOUNT_FUZZY)].map((match) => match[0].trim())),
    );
    if (fuzzy !== undefined) {
      put(fields, "amount", fuzzy, FUZZY_CONFIDENCE);
      return fuzzy;
    }
    if (labelWithoutValue) put(fields, "amount", null, 0);
    return undefined;
  }

  /** Currency: a labelled ISO code, else the symbol on the amount; unknown
   *  symbols are noted and default GBP (the 1.3 parser semantics, plan §3). */
  private extractCurrency(
    lines: string[],
    amountRaw: string | undefined,
    fields: Fields,
    notes: string[],
  ): void {
    for (const line of lines) {
      const match = CURRENCY_LABEL.exec(line);
      const code = match?.[1] ? normaliseImportCurrency(match[1]) : null;
      if (code) {
        put(fields, "currency", code, LABEL_CONFIDENCE);
        return;
      }
    }
    const symbol = amountRaw?.match(/[£$€¥₹₩]/)?.[0] ?? lines.join(" ").match(/[£$€¥₹₩]/)?.[0];
    if (symbol !== undefined) {
      const code = CURRENCY_SYMBOLS[symbol];
      if (code !== undefined) {
        put(fields, "currency", code, LABEL_CONFIDENCE);
      } else {
        notes.push(`unrecognised currency symbol '${symbol}' — defaulted to GBP`);
        put(fields, "currency", "GBP", FUZZY_CONFIDENCE);
      }
    }
    // No currency evidence at all → absent; confirm defaults GBP (1.3 semantics).
  }

  /** Customer name/reference and contact name by label proximity (plan §3). */
  private extractParties(lines: string[], fields: Fields): void {
    for (const [index, line] of lines.entries()) {
      if (fields.customerReference === undefined) {
        const reference = CUSTOMER_REFERENCE_LABEL.exec(line);
        if (reference?.[1]) put(fields, "customerReference", reference[1].trim(), LABEL_CONFIDENCE);
      }
      if (
        fields.customerName === undefined &&
        !CUSTOMER_REFERENCE_LABEL.test(line) &&
        !CUSTOMER_EMAIL_LABEL.test(line)
      ) {
        const name = CUSTOMER_NAME_LABEL.exec(line);
        if (name) {
          const sameLine = cleanPartyValue(name[1]);
          // "Bill To:" with the name on the NEXT line is the classic layout.
          const nextLine = cleanPartyValue(lines[index + 1]);
          const value = sameLine ?? nextLine;
          put(fields, "customerName", value ?? null, value ? LABEL_CONFIDENCE : 0);
        }
      }
      if (fields.contactName === undefined) {
        const contact = CONTACT_NAME_LABEL.exec(line);
        if (contact) {
          const value = cleanPartyValue(contact[1]);
          put(fields, "contactName", value ?? null, value ? LABEL_CONFIDENCE : 0);
        }
      }
    }
  }

  /** Emails: RFC-ish pattern; customer vs contact decided by label proximity. */
  private extractEmails(lines: string[], fields: Fields): void {
    const generic: string[] = [];
    for (const line of lines) {
      const emails = line.match(new RegExp(EMAIL_VALUE, "g")) ?? [];
      if (emails.length === 0) continue;
      if (fields.contactEmail === undefined && CONTACT_EMAIL_LABEL.test(line)) {
        put(fields, "contactEmail", emails[0]!.toLowerCase(), LABEL_CONFIDENCE);
        generic.push(...emails.slice(1));
      } else if (fields.customerEmail === undefined && CUSTOMER_EMAIL_LABEL.test(line)) {
        put(fields, "customerEmail", emails[0]!.toLowerCase(), LABEL_CONFIDENCE);
        generic.push(...emails.slice(1));
      } else {
        generic.push(...emails);
      }
    }
    // Unlabelled emails: first is the customer's, second the contact's (fuzzy).
    for (const email of generic) {
      const normalised = email.toLowerCase();
      if (fields.customerEmail === undefined) {
        put(fields, "customerEmail", normalised, FUZZY_CONFIDENCE);
      } else if (fields.contactEmail === undefined && fields.customerEmail.value !== normalised) {
        put(fields, "contactEmail", normalised, FUZZY_CONFIDENCE);
      }
    }
  }
}

function put(fields: Fields, field: ExtractableField, value: string | null, confidence: number) {
  const entry: ExtractedFieldValue = { value, confidence };
  fields[field] = entry;
}

/** A usable party value: no emails, no trailing labels, non-empty. */
function cleanPartyValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || EMAIL_VALUE.test(value) || value.endsWith(":")) return undefined;
  return value;
}

/** Parse a candidate amount string (symbols beyond £/$ stripped first — the
 *  shared parser mirrors the 1.3 file semantics, which only ever see £/$). */
function parseAmount(raw: string): number | null {
  return parseImportAmount(raw.replace(/[€¥₹₩]/g, ""));
}

/** The candidate with the largest parsed minor units (plan §3 tiebreak). */
function largest(candidates: string[]): string | undefined {
  let best: { raw: string; minorUnits: number } | undefined;
  for (const raw of candidates) {
    const minorUnits = parseAmount(raw);
    if (minorUnits !== null && (best === undefined || minorUnits > best.minorUnits)) {
      best = { raw, minorUnits };
    }
  }
  return best?.raw;
}

/** Reads the PDF text layer and reconstructs reading-order lines: text items
 *  are grouped by y position (a small tolerance), then sorted by x (plan §3). */
async function extractTextLines(content: Buffer): Promise<string[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(content),
    // Node.js runtime: no bundled fonts, no font-face loading — text
    // positions are all the heuristics need (plan §7.4).
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: VerbosityLevel.ERRORS,
  });
  const pdf = await loadingTask.promise;
  try {
    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const rows: { y: number; items: { x: number; str: string }[] }[] = [];
      for (const item of textContent.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        const row = rows.find((candidate) => Math.abs(candidate.y - y) <= 3);
        if (row) row.items.push({ x, str: item.str });
        else rows.push({ y, items: [{ x, str: item.str }] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x);
        lines.push(
          row.items
            .map((item) => item.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        );
      }
    }
    return lines;
  } finally {
    await loadingTask.destroy();
  }
}
