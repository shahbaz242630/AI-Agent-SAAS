/**
 * Re-export shim (Slice 1.4): the semantic value parsers were promoted to
 * common/ledger/values.ts so the PDF extraction adapter shares them (plan §3).
 * This path keeps the 1.3 module's imports (and its spec) unchanged.
 */
export {
  normaliseImportCurrency,
  parseImportAmount,
  parseImportDate,
} from "../../common/ledger/values.js";
