/**
 * The currency codes the invoice forms offer, and the rule for which one is
 * pre-selected (slice 1.6c, task 13).
 *
 * ⚠️ SUGGESTIONS ONLY — NEVER A RESTRICTION. A hard-coded list is a decision
 * about which markets we serve, and this is a convenience widget. The API
 * accepts any three-letter ISO 4217 code, and the money layer already knows the
 * minor-unit digits for all of them. It covers the three exponent groups and
 * the markets named so far: 2-digit, the 3-digit Gulf currencies, 0-digit Asia.
 *
 * ⚠️ ONE LIST, because there were two — `invoice-controls.tsx` and
 * `add-row-form.tsx` each kept their own, and they had ALREADY diverged in
 * ordering by the time this was written. Two lists of currencies become two
 * different answers to "can I invoice in Singapore dollars", which is exactly
 * the kind of quiet disagreement this project keeps paying for.
 */
export const CURRENCY_SUGGESTIONS = [
  "GBP",
  "AED",
  "USD",
  "EUR",
  "SAR",
  "QAR",
  // Added 2026-08-04: the founder named a UK seller with buyers in Singapore.
  // 2-decimal, so the money layer already handled it — it was only missing
  // from the convenience list.
  "SGD",
  // The three-decimal Gulf currencies. Their presence here is the standing
  // reminder that `* 100` is a defect: 12.345 KWD is a valid amount.
  "KWD",
  "BHD",
  "OMR",
  // Zero-decimal. 650000 JPY is 650000 minor units, not 65,000,000.
  "JPY",
  "KRW",
  "VND",
] as const;

/**
 * The last-resort currency when nothing else has an opinion.
 *
 * Only used when the organisation summary carries no `defaultCurrency` at all —
 * an older API build, or a partial deploy. The launch market is the UK, so GBP
 * is the honest guess, and it matches the database column's own default so the
 * two cannot disagree about what "unset" means.
 */
export const FALLBACK_CURRENCY = "GBP";

/**
 * Which currency a new invoice form opens on.
 *
 * ⚠️ THE ORDER OF PREFERENCE IS THE WHOLE POINT, and it goes from most specific
 * evidence to least:
 *
 * 1. **What this client is already invoiced in**, when every existing invoice
 *    agrees. A client billed in AED four times is going to be billed in AED
 *    again, and that beats any organisation-wide setting. When they DISAGREE
 *    there is no obvious answer, and guessing one is how the wrong currency
 *    gets onto an invoice — so the mixed case falls through deliberately rather
 *    than picking the commonest.
 * 2. **The organisation's own default** (task 13) — what a Dubai business set
 *    so it stops typing AED fifty times a week.
 * 3. **GBP**, the launch market.
 *
 * ⚠️ THIS IS A PRE-SELECTION AND NOTHING ELSE (founder ruling 2026-08-04). The
 * dropdown still offers every code, the API still accepts any of them, and no
 * caller may read this to REFUSE a currency. A UK business invoicing a buyer in
 * Singapore must be able to raise that invoice in SGD with two clicks.
 */
export function defaultInvoiceCurrency(input: {
  /** Currencies already used on this client's invoices, if a client is in view. */
  existingCurrencies?: readonly string[];
  /** The organisation's setting, as published on its summary. */
  organisationDefault?: string;
}): string {
  const distinct = new Set(input.existingCurrencies ?? []);
  if (distinct.size === 1) return [...distinct][0]!;
  return input.organisationDefault?.trim() || FALLBACK_CURRENCY;
}
