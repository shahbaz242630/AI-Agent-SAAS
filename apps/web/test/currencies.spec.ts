import { describe, expect, it } from "vitest";
import { CURRENCY_SUGGESTIONS, FALLBACK_CURRENCY, defaultInvoiceCurrency } from "@/lib/currencies";

/**
 * Task 13. The assertions that matter here are about PRECEDENCE and about the
 * founder's ruling that this is a default and never a restriction.
 */

describe("defaultInvoiceCurrency", () => {
  it("prefers what this client is already invoiced in", () => {
    // Specific evidence beats an organisation-wide setting: a client billed in
    // AED four times is going to be billed in AED again.
    expect(
      defaultInvoiceCurrency({
        existingCurrencies: ["AED", "AED", "AED"],
        organisationDefault: "GBP",
      }),
    ).toBe("AED");
  });

  it("falls through to the organisation default when the client's invoices DISAGREE", () => {
    /**
     * ⚠️ NOT "the commonest one". A client holding both AED and GBP has no
     * obvious answer, and picking the majority is how the wrong currency gets
     * onto an invoice — confidently, and with a plausible-looking reason.
     */
    expect(
      defaultInvoiceCurrency({
        existingCurrencies: ["AED", "AED", "GBP"],
        organisationDefault: "SGD",
      }),
    ).toBe("SGD");
  });

  it("uses the organisation default for a client with no invoices at all", () => {
    // The case task 13 exists for: a UAE business raising its first invoice
    // against a new client should not be handed GBP.
    expect(defaultInvoiceCurrency({ existingCurrencies: [], organisationDefault: "AED" })).toBe(
      "AED",
    );
    expect(defaultInvoiceCurrency({ organisationDefault: "AED" })).toBe("AED");
  });

  it("falls back to GBP only when nothing has an opinion", () => {
    expect(defaultInvoiceCurrency({})).toBe(FALLBACK_CURRENCY);
    expect(defaultInvoiceCurrency({ organisationDefault: "" })).toBe("GBP");
    expect(defaultInvoiceCurrency({ organisationDefault: "   " })).toBe("GBP");
    // An older API build that sends no field at all must still yield a form
    // that works, not `undefined` in a <select>.
    expect(defaultInvoiceCurrency({ organisationDefault: undefined })).toBe("GBP");
  });

  it("never restricts: an organisation default outside the suggestion list is still honoured", () => {
    /**
     * ⚠️ THE FOUNDER'S RULING, PINNED. The suggestion list is a convenience, so
     * an organisation that set a code we do not list must still get it
     * pre-selected rather than being silently reset to GBP. If this ever fails,
     * the list has quietly become a whitelist.
     */
    expect(defaultInvoiceCurrency({ organisationDefault: "ZAR" })).toBe("ZAR");
    expect(CURRENCY_SUGGESTIONS).not.toContain("ZAR");
  });
});

describe("CURRENCY_SUGGESTIONS", () => {
  it("covers all three minor-unit exponent groups", () => {
    // The list doubles as the standing reminder that `* 100` is a defect.
    expect(CURRENCY_SUGGESTIONS).toContain("GBP"); // 2 digits
    expect(CURRENCY_SUGGESTIONS).toContain("KWD"); // 3 digits
    expect(CURRENCY_SUGGESTIONS).toContain("JPY"); // 0 digits
  });

  it("includes every market the founder has named", () => {
    for (const code of ["GBP", "AED", "USD", "SGD"]) {
      expect(CURRENCY_SUGGESTIONS, code).toContain(code);
    }
  });

  it("has no duplicates", () => {
    // It was two lists until task 13 merged them; a duplicate would render two
    // identical <option>s and is the obvious way that merge could have gone
    // wrong.
    expect(new Set(CURRENCY_SUGGESTIONS).size).toBe(CURRENCY_SUGGESTIONS.length);
  });

  it("is entirely well-formed ISO 4217 codes", () => {
    // A lowercase entry would miss the money layer's minor-unit table and
    // silently take the 2-digit fallback.
    for (const code of CURRENCY_SUGGESTIONS) {
      expect(code, code).toMatch(/^[A-Z]{3}$/);
    }
  });
});
