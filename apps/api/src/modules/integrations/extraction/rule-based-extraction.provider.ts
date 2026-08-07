import { Injectable } from "@nestjs/common";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ExtractableField, ExtractedFieldValue } from "@eva/types";
import {
  parseImportAmount,
  normaliseImportCurrency,
  RANKING_PRECISION_CURRENCY,
} from "../../../common/ledger/values.js";
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
 * (items grouped by y position, split at column gaps, sorted by x), then
 * labelled-field heuristics find the ten canonical fields. No AI provider, no
 * external calls, no API keys — personal data never leaves the platform.
 *
 * Confidence is rule-derived (plan §3): an exact label with an adjacent
 * value → 0.9; a fuzzy match (value found without a label, e.g. the largest
 * amount on the page) → 0.5; a label found with no usable value → present
 * with value null and 0; a field never seen → absent from the result (the
 * review payload flags missing required fields; the human completes them at
 * confirm — the §7.7 hybrid ruling).
 *
 * ⚠️ THE RULES IN HERE WERE WRITTEN AGAINST INVOICES WE INVENTED, AND EVERY
 * ONE OF THEM FAILED ON THE FIRST EIGHT REAL DOCUMENTS (2026-08-04). What the
 * founder's own AED invoices exposed, all fixed here and each pinned by a test
 * in `rule-based-extraction.spec.ts`:
 *
 *   1. `Due Date : 10 Apr 2026` — a textual month is the commonest date form on
 *      a real invoice and NO date format with a month name was recognised, so
 *      the one field a chasing product cannot work without came back null on
 *      all eight.
 *   2. `Sub Total 47,619.05` was returned as the amount at the HIGHEST
 *      confidence while the document said `Total AED50,000.00`, because
 *      `\btotal\b` matches inside "Sub Total" and the value regex could not see
 *      past an ISO code to the digits.
 *   3. The only email on the page is the SENDER'S OWN, and an unlabelled-email
 *      fallback handed it back as the customer's — Eva would have emailed the
 *      customer instead of their debtor.
 *   4. `Mr. Nicolas Invoice Date : 10 Apr 2026` — a PDF text layer does not
 *      respect visual columns, so the name column and the dates column were
 *      joined into one line.
 *   5. Not on that list and just as expensive: the currency came back ABSENT on
 *      an AED invoice, and confirm defaults absent to GBP. A Dubai invoice
 *      became a sterling one, silently.
 */

/** Exact label with an adjacent value. */
const LABEL_CONFIDENCE = 0.9;
/** Found without a label (fuzzy). */
const FUZZY_CONFIDENCE = 0.5;

/**
 * A column boundary, as a fraction of page width.
 *
 * ⚠️ MEASURED ON REAL DOCUMENTS, NOT CHOSEN. On the founder's invoices the gap
 * between the "Bill To" name column and the dates column is 290–331 units on a
 * 595-unit page (49–56%), while the gap between a label and its own value —
 * `Due Date :` → `10 Apr 2026` — is 59 (10%). Anything between those two
 * separates columns without splitting a label from its value; 15% sits clear of
 * both. Expressed as a fraction because a fixed number in PDF units means
 * something different on every page size.
 */
const COLUMN_GAP_RATIO = 0.15;

/** Month names, so `10 Apr 2026` and `April 10, 2026` both resolve. */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * The date forms a real invoice uses, as ONE capture group.
 *
 * ⚠️ Separators are bounded (`{1,2}`), never `+`. This pattern runs over text
 * from an uploaded file, and an unbounded repeat next to another repeat is the
 * polynomial-backtracking shape CodeQL flagged on `parseAmountToMinorUnits`.
 * Line reconstruction has already collapsed runs of whitespace to one space, so
 * a bound of two costs nothing.
 */
const DATE_VALUE =
  `(` +
  String.raw`\d{4}-\d{2}-\d{2}` +
  `|` +
  String.raw`\d{1,2}\/\d{1,2}\/\d{4}` +
  `|` +
  String.raw`\d{1,2}[ \-.]{1,2}[A-Za-z]{3,9}\.?[ \-.,]{1,2}\d{4}` +
  `|` +
  String.raw`[A-Za-z]{3,9}\.?[ \-.]{1,2}\d{1,2}(?:st|nd|rd|th)?[ \-.,]{1,2}\d{4}` +
  `)`;

/**
 * An amount as written, including an ISO code on the left.
 *
 * ⚠️ `Total AED50,000.00` used to capture NOTHING: the old pattern allowed a
 * symbol (`£$€`) before the digits but not a three-letter code, so the real
 * total was invisible and "Sub Total" won by being the only candidate left.
 *
 * ⚠️ Up to THREE decimals, not two. The money layer was widened for KWD/BHD/OMR
 * in slice 1.6c but this capture still stopped at two, which quietly undid it
 * one layer out: `12.345 KWD` would have been captured as `12.34`.
 *
 * ⚠️ THE CODE MUST BE A WHOLE TOKEN — `\b` in front, "not another letter"
 * behind. Without the boundary the three letters happily matched the TAIL of a
 * longer word: `Total £1,250.00` matched "tal £1,250.00", and the currency read
 * off it was "TAL". Found by removing the currency allowlist and seeing what
 * got through, which is the only reason it was noticed at all.
 */
const CODE_PREFIX = String.raw`(?:\b[A-Za-z]{3}(?![A-Za-z])\s*)?`;
const AMOUNT_VALUE = String.raw`(${CODE_PREFIX}[£$€¥₹₩]?\s*\d[\d,]*(?:\.\d{1,3})?)`;

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

/**
 * The invoice TOTAL.
 *
 * ⚠️ `(?<!sub[\s-]?)` is the whole point. `\btotal\b` matches inside "Sub
 * Total", and on the founder's invoices the sub total (47,619.05, pre-tax) was
 * returned as the amount at confidence 0.9 while the document said
 * `Total AED50,000.00`. Eva would have chased for the wrong figure and
 * presented it as reliable.
 *
 * ⚠️ Bare "Amount" is deliberately NOT a total label. On every real document it
 * was a TABLE COLUMN HEADER ("# Item & Description Qty Rate Tax Amount"), and
 * "Quote Amount -54,000/=" in a line-item description is not the invoice total
 * either. An unlabelled amount is still reachable through the fuzzy tier below,
 * at a confidence that says so.
 */
const TOTAL_LABEL = new RegExp(
  String.raw`(?<!sub[\s-]?)\b(?:grand\s+total|invoice\s+total|total\s+amount|total\s+payable|total\s+due|total)\b` +
    String.raw`\s*:?\s*` +
    `${AMOUNT_VALUE}?`,
  "i",
);

/**
 * What is OUTSTANDING — a fallback, never preferred.
 *
 * ⚠️ "Balance Due" is not the invoice total and must not outrank one. The
 * founder's INV-000198 is settled: it reads `Balance Due AED0.00` and
 * `Total AED50,000.00`. Preferring the more specific-sounding label would have
 * extracted an amount of ZERO — worse than the bug being fixed.
 */
const OUTSTANDING_LABEL = new RegExp(
  String.raw`\b(?:amount\s+due|balance\s+due|amount\s+payable|balance)\b` +
    String.raw`\s*:?\s*` +
    `${AMOUNT_VALUE}?`,
  "i",
);

const AMOUNT_FUZZY = new RegExp(
  `${CODE_PREFIX}` + String.raw`[£$€¥₹₩]?\s*\d[\d,]*\.\d{2,3}\b`,
  "g",
);
const CURRENCY_LABEL = /\bcurrency\b\s*:?\s*([A-Za-z]{3})\b/i;
const CUSTOMER_NAME_LABEL =
  /\b(?:bill\s*to|invoice\s*to|sold\s*to|customer\s*name|customer)\b\s*:?\s*(.*)/i;
const CUSTOMER_REFERENCE_LABEL =
  /\bcustomer\s*(?:ref(?:erence)?|account(?:\s*(?:number|no))?|id)\b\s*:?\s*(\S+)/i;
const CONTACT_NAME_LABEL = /\b(?:attention|attn|contact(?:\s*name)?)\b\s*:?\s*(.*)/i;
const CUSTOMER_EMAIL_LABEL = /\b(?:customer|billing|accounts?)\s*e-?mail\b/i;
const CONTACT_EMAIL_LABEL = /\b(?:contact|attn|attention)\b/i;

/**
 * A label belonging to a DIFFERENT field, used to cut a party value short.
 *
 * Defence in depth behind the column split: where a layout puts two fields on
 * one visual line with a gap too small to be a column, the name would otherwise
 * absorb the next field's label and value — "Mr. Nicolas Invoice Date : 10 Apr
 * 2026" is the real example.
 */
const OTHER_FIELD_LABEL = String.raw`(?:invoice\s+date|issued?\s+date|due\s+date|date\s+due|payment\s+due|expiry\s+date|valid\s+(?:un)?till|terms|invoice\s*(?:number|no\.?|#)|p\.?o\.?\s*#?|quote\s*#?|balance\s+due|amount\s+due|sub\s*total|total)\b`;
const TRAILING_LABEL = new RegExp(String.raw`\s+${OTHER_FIELD_LABEL}.*$`, "i");

/**
 * A line that IS another field, not a party.
 *
 * ⚠️ WHY SCANNING PAST IT IS NECESSARY AND NOT OVER-ENGINEERING. Column
 * splitting fixes a row that holds two columns, but it cannot fix READING
 * ORDER: on INV-000208 the right-hand column's first row sits a few points
 * HIGHER than the customer's name, so the line after "Bill To" is
 * `Invoice Date : 02 Aug 2026` and the name is the line after that. Taking the
 * next line blindly returned the date as the customer's name on two of the
 * eight real documents.
 */
const LEADING_LABEL = new RegExp(String.raw`^${OTHER_FIELD_LABEL}`, "i");

/** How far past a "Bill To" to look for the name before giving up. Bounded so a
 *  document with no name cannot walk into the address or the line items. */
const PARTY_LOOKAHEAD = 3;

/** Currency symbols mapped to ISO codes; anything else is unknown (noted). */
const CURRENCY_SYMBOLS: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };

/**
 * Currency codes we will accept from a bare three-letter token on the page.
 *
 * ⚠️ AN ALLOWLIST, BECAUSE A DOCUMENT IS FULL OF THREE-LETTER WORDS THAT SIT
 * NEXT TO NUMBERS. The founder's invoices carry `TRN 104409376100003` (a UAE
 * tax registration number) three lines above the total; accepting any
 * `[A-Z]{3}` adjacent to a digit would have made the currency "TRN".
 *
 * This is the launch list plus every currency the minor-unit table names, not
 * all of ISO 4217. A code that is not here is simply not evidence, and the
 * field stays absent — which is exactly what happens today for every document,
 * so an unlisted currency is no worse off than before. Add to it when a market
 * needs it; there is a test that a code outside the list is refused.
 */
const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set([
  // Launch and stated next markets.
  "GBP",
  "EUR",
  "USD",
  "AED",
  "SAR",
  "QAR",
  "KWD",
  "BHD",
  "OMR",
  "JOD",
  "SGD",
  "INR",
  "PKR",
  "JPY",
  "KRW",
  "VND",
  "IDR",
  "MYR",
  "HKD",
  "CNY",
  "AUD",
  "NZD",
  "CAD",
  "CHF",
  "ZAR",
  "TRY",
  "EGP",
  // The remaining non-two-digit currencies, so the money layer and this agree.
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "KMF",
  "PYG",
  "RWF",
  "UGX",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
  "IQD",
  "LYD",
  "TND",
]);

type Fields = ExtractionResult["fields"];

/** One text run from the PDF text layer, in page coordinates. */
export interface PositionedText {
  x: number;
  y: number;
  width: number;
  str: string;
}

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
    return extractFieldsFromLines(lines);
  }
}

/**
 * The field heuristics, over reconstructed lines.
 *
 * Exported and pure so it can be tested against the line shapes real documents
 * actually produce. ⚠️ Until this was split out there was NO unit test of the
 * extractor at all — the two invoice-documents specs exercise the module around
 * it with a stubbed provider — which is how four defects survived on every
 * document we owned.
 */
export function extractFieldsFromLines(lines: string[]): ExtractionResult {
  const notes: string[] = [];
  const fields: Fields = {};
  extractInvoiceNumber(lines, fields, notes);
  extractDates(lines, fields);
  const amountRaw = extractAmount(lines, fields);
  extractCurrency(lines, amountRaw, fields, notes);
  extractParties(lines, fields);
  extractEmails(lines, fields, notes);
  return { fields, notes };
}

/** Invoice number: label + same-line value; multiple distinct numbers mean
 *  a multi-invoice PDF — one invoice per PDF (plan §7.3), first wins + note. */
function extractInvoiceNumber(lines: string[], fields: Fields, notes: string[]): void {
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

/**
 * Dates: ISO, UK slash, and textual-month forms near date labels; dueDate
 * prefers due/payment-due labels (plan §3).
 *
 * ⚠️ EVERY DATE IS NORMALISED TO ISO before it is stored. `parseImportDate` at
 * confirm accepts only ISO and DD/MM/YYYY, so returning the document's own
 * "10 Apr 2026" would have moved the failure from extraction to confirm rather
 * than fixing it. Normalising HERE also settles the ambiguity where the
 * document is unambiguous — "10 Apr 2026" can only be one date, whereas
 * 10/04/2026 cannot — and the reviewer then sees one consistent format.
 *
 * Slash dates keep `parseImportDate`'s day-first reading exactly, so no date
 * that already worked changes meaning.
 */
function extractDates(lines: string[], fields: Fields): void {
  let dueLabelWithoutValue = false;
  let issueLabelWithoutValue = false;
  for (const line of lines) {
    if (fields.dueDate === undefined) {
      const due = DUE_DATE_LABEL.exec(line);
      if (due) {
        const iso = toIsoDate(due[1]);
        if (iso) put(fields, "dueDate", iso, LABEL_CONFIDENCE);
        else dueLabelWithoutValue = true;
      }
    }
    if (fields.issueDate === undefined && !DUE_DATE_LABEL.test(line)) {
      const issue = ISSUE_DATE_LABEL.exec(line);
      if (issue) {
        const iso = toIsoDate(issue[1]);
        if (iso) put(fields, "issueDate", iso, LABEL_CONFIDENCE);
        else issueLabelWithoutValue = true;
      }
    }
  }
  // Fuzzy fallback: date forms found anywhere, the last one first (unlabelled).
  const fuzzyDates = lines.flatMap((line) => {
    const found: string[] = [];
    for (const match of line.matchAll(new RegExp(DATE_VALUE, "gi"))) {
      const iso = toIsoDate(match[1]);
      if (iso) found.push(iso);
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

/**
 * Amount, in tiers: the invoice TOTAL wins; what is OUTSTANDING is only a
 * fallback; an unlabelled figure is last and says so with its confidence.
 *
 * Within a tier the largest wins (plan §3 tiebreak) — a document repeats its
 * total in a tax summary, and the larger figure is the gross one.
 */
function extractAmount(lines: string[], fields: Fields): string | undefined {
  let labelWithoutValue = false;

  const collect = (pattern: RegExp): string[] => {
    const candidates: string[] = [];
    for (const line of lines) {
      const match = pattern.exec(line);
      if (!match) continue;
      const raw = match[1]?.trim();
      if (raw && parseAmount(raw) !== null) candidates.push(raw);
      else labelWithoutValue = true;
    }
    return candidates;
  };

  const total = largest(collect(TOTAL_LABEL));
  if (total !== undefined) {
    put(fields, "amount", total, LABEL_CONFIDENCE);
    return total;
  }
  const outstanding = largest(collect(OUTSTANDING_LABEL));
  if (outstanding !== undefined) {
    put(fields, "amount", outstanding, LABEL_CONFIDENCE);
    return outstanding;
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

/**
 * Currency: a labelled ISO code, else a code written against the amount, else
 * the symbol on the amount; unknown symbols are noted and default GBP.
 *
 * ⚠️ THE CODE-AGAINST-THE-AMOUNT RULE IS THE ONE THAT MATTERED. The founder's
 * invoices write `Total AED50,000.00` — no symbol anywhere, no "Currency:"
 * label — so the field came back ABSENT and confirm defaults absent to GBP. A
 * Dubai invoice was becoming a sterling one with nothing on screen to say so.
 */
function extractCurrency(
  lines: string[],
  amountRaw: string | undefined,
  fields: Fields,
  notes: string[],
): void {
  for (const line of lines) {
    const match = CURRENCY_LABEL.exec(line);
    const code = match?.[1] ? normaliseImportCurrency(match[1]) : null;
    if (code && KNOWN_CURRENCY_CODES.has(code)) {
      put(fields, "currency", code, LABEL_CONFIDENCE);
      return;
    }
  }
  // A code written against the winning amount is the strongest remaining
  // evidence — it is attached to the very number we are about to store.
  const onAmount = knownCodeIn(amountRaw);
  if (onAmount) {
    put(fields, "currency", onAmount, LABEL_CONFIDENCE);
    return;
  }
  // Otherwise a code written against ANY amount on the page.
  for (const line of lines) {
    for (const match of line.matchAll(AMOUNT_FUZZY)) {
      const code = knownCodeIn(match[0]);
      if (code) {
        put(fields, "currency", code, FUZZY_CONFIDENCE);
        return;
      }
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
function extractParties(lines: string[], fields: Fields): void {
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
        // "Bill To:" with the name on a FOLLOWING line is the classic layout —
        // following, not next: see LEADING_LABEL.
        const value = cleanPartyValue(name[1]) ?? nextPartyLine(lines, index);
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

/**
 * Emails: only ones a LABEL attributes to the customer or the contact.
 *
 * ⚠️ AN UNLABELLED EMAIL IS NOT EVIDENCE OF THE DEBTOR'S ADDRESS, AND GUESSING
 * SENDS THE CHASE TO THE WRONG PERSON. The rule used to be "the first
 * unlabelled email is the customer's". On all eight of the founder's real
 * invoices the only email on the page is the SENDER'S OWN
 * (`admin@onestepfixit.com`, in the letterhead), so that rule returned our own
 * customer's address as the debtor's — and Eva would have chased them with it.
 *
 * Those documents carry no debtor email at all, so extraction can never supply
 * one: a human must, and the confirm screen exists for exactly that (§7.7). An
 * absent field asks them; a wrong field does not. The addresses found are put
 * in the notes so the reviewer can still see them.
 */
function extractEmails(lines: string[], fields: Fields, notes: string[]): void {
  const unattributed: string[] = [];
  for (const line of lines) {
    const emails = line.match(new RegExp(EMAIL_VALUE, "g")) ?? [];
    if (emails.length === 0) continue;
    if (fields.contactEmail === undefined && CONTACT_EMAIL_LABEL.test(line)) {
      put(fields, "contactEmail", emails[0]!.toLowerCase(), LABEL_CONFIDENCE);
      unattributed.push(...emails.slice(1));
    } else if (fields.customerEmail === undefined && CUSTOMER_EMAIL_LABEL.test(line)) {
      put(fields, "customerEmail", emails[0]!.toLowerCase(), LABEL_CONFIDENCE);
      unattributed.push(...emails.slice(1));
    } else {
      unattributed.push(...emails);
    }
  }
  const distinct = [...new Set(unattributed.map((email) => email.toLowerCase()))];
  if (distinct.length > 0 && fields.customerEmail === undefined) {
    notes.push(
      `email addresses were found but none is labelled as the customer's, and the sender's own ` +
        `address usually is the only one on an invoice — enter the debtor's address yourself: ` +
        distinct.join(", "),
    );
  }
}

function put(fields: Fields, field: ExtractableField, value: string | null, confidence: number) {
  const entry: ExtractedFieldValue = { value, confidence };
  fields[field] = entry;
}

/**
 * A recognised ISO 4217 code written against an amount, e.g. `AED50,000.00`.
 * Returns undefined for anything not on the allowlist — see
 * `KNOWN_CURRENCY_CODES` for why that list is not all of ISO 4217.
 */
function knownCodeIn(raw: string | undefined): string | undefined {
  const match = raw?.match(/[A-Za-z]{3}/)?.[0];
  if (!match) return undefined;
  const code = match.toUpperCase();
  return KNOWN_CURRENCY_CODES.has(code) ? code : undefined;
}

/**
 * A date as written → `YYYY-MM-DD`, or null if it is not a real date.
 *
 * Validates the calendar, not just the shape: `31 Feb 2026` and `2026-13-01`
 * are refused rather than rolled over into March.
 */
export function toIsoDate(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const dayFirst = /^(\d{1,2})[ \-.]{1,2}([A-Za-z]{3,9})\.?[ \-.,]{1,2}(\d{4})$/.exec(value);
  const monthFirst =
    /^([A-Za-z]{3,9})\.?[ \-.]{1,2}(\d{1,2})(?:st|nd|rd|th)?[ \-.,]{1,2}(\d{4})$/.exec(value);

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (slash) {
    // Day first — the same reading `parseImportDate` has always used, so no
    // date that already worked changes meaning here.
    day = Number(slash[1]);
    month = Number(slash[2]);
    year = Number(slash[3]);
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = monthNumber(dayFirst[2]!);
    year = Number(dayFirst[3]);
  } else if (monthFirst) {
    month = monthNumber(monthFirst[1]!);
    day = Number(monthFirst[2]);
    year = Number(monthFirst[3]);
  } else {
    return null;
  }

  if (month === undefined || day === undefined || year === undefined) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!valid) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "Apr", "April", "SEPT" → 1–12; undefined when it is not a month name. */
function monthNumber(name: string): number | undefined {
  const lower = name.toLowerCase();
  if (MONTHS[lower] !== undefined) return MONTHS[lower];
  // Full names ("january") and any other prefix form resolve on their first
  // three letters, which is unambiguous for all twelve months.
  return MONTHS[lower.slice(0, 3)];
}

/** A usable party value: no emails, not another field, no trailing labels. */
function cleanPartyValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || LEADING_LABEL.test(trimmed)) return undefined;
  const value = trimmed.replace(TRAILING_LABEL, "").trim();
  if (!value || EMAIL_VALUE.test(value) || value.endsWith(":")) return undefined;
  return value;
}

/**
 * The first line after a party label that is actually a party — skipping lines
 * that belong to another field because the two columns interleave by height.
 */
function nextPartyLine(lines: string[], labelIndex: number): string | undefined {
  for (let offset = 1; offset <= PARTY_LOOKAHEAD; offset++) {
    const candidate = cleanPartyValue(lines[labelIndex + offset]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Parse a candidate amount for RANKING only — see `RANKING_PRECISION_CURRENCY`.
 *
 * The currency of the document is extracted separately and may not be known
 * yet, so candidates are parsed at the widest precision ISO 4217 defines.
 * Parsing them at two decimals would drop every three-decimal amount out of
 * contention before the currency was even read, which is how a Kuwaiti invoice
 * would end up proposing the wrong number.
 */
function parseAmount(raw: string): number | null {
  return parseImportAmount(raw, RANKING_PRECISION_CURRENCY);
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

/**
 * Text runs → reading-order lines: grouped by y position (a small tolerance),
 * sorted by x, and SPLIT WHERE A HORIZONTAL GAP IS WIDE ENOUGH TO BE A COLUMN.
 *
 * ⚠️ THE SPLIT IS THE POINT. A PDF text layer is a stream of positioned runs
 * with no notion of columns, so an invoice whose header puts the customer on
 * the left and the dates on the right yields one row containing both. Joining
 * that row gave `Mr. Nicolas Invoice Date : 10 Apr 2026` — which is what the
 * customer's NAME was extracted as. Each column becomes its own line instead,
 * left to right, so "Bill To" is still followed by the name.
 *
 * Exported for tests: the defect lives in geometry, and synthetic runs pin it
 * without needing a PDF (and without committing the founder's real documents,
 * which are live business records in a PUBLIC repo).
 */
export function groupTextItemsIntoLines(items: PositionedText[], pageWidth: number): string[] {
  const rows: { y: number; items: PositionedText[] }[] = [];
  for (const item of items) {
    if (item.str.trim() === "") continue;
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  rows.sort((a, b) => b.y - a.y);

  const gapThreshold = pageWidth * COLUMN_GAP_RATIO;
  const lines: string[] = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let current: string[] = [];
    let previous: PositionedText | undefined;
    for (const item of row.items) {
      if (previous !== undefined && item.x - (previous.x + previous.width) > gapThreshold) {
        pushLine(lines, current);
        current = [];
      }
      current.push(item.str);
      previous = item;
    }
    pushLine(lines, current);
  }
  return lines;
}

function pushLine(lines: string[], parts: string[]): void {
  const line = parts.join(" ").replace(/\s+/g, " ").trim();
  if (line !== "") lines.push(line);
}

/** Reads the PDF text layer and reconstructs reading-order lines (plan §3). */
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
      const pageWidth = page.getViewport({ scale: 1 }).width;
      const items: PositionedText[] = [];
      for (const item of textContent.items) {
        if (!("str" in item)) continue;
        items.push({
          x: item.transform[4] ?? 0,
          y: item.transform[5] ?? 0,
          width: item.width ?? 0,
          str: item.str,
        });
      }
      lines.push(...groupTextItemsIntoLines(items, pageWidth));
    }
    return lines;
  } finally {
    await loadingTask.destroy();
  }
}
