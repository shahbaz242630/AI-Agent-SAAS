import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `createInvoice` (slice 1.6c, task 3).
 *
 * ⚠️ WHAT THESE TESTS ARE REALLY FOR: the BODY that reaches the API. The
 * amount arrives as something a person typed and has to leave as integer minor
 * units for the currency chosen on the same form. `@eva/types` is NOT mocked
 * here, so these assert the real conversion end to end — a `* 100` creeping
 * back in would show up as a wrong number in the request, which is exactly
 * where it would do damage.
 *
 * The API call itself is stubbed; what the API does with a valid body is proven
 * by the api suite.
 */

const apiFetch = vi.fn();
const redirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  }),
}));

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

/** A complete, valid submission — individual tests override one field. */
function validForm(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    organisationId: "org-1",
    customerId: "cust-1",
    invoiceNumber: "INV-9001",
    amount: "1234.56",
    currency: "GBP",
    dueDate: "2026-09-30",
    status: "draft",
  };
  return form(Object.entries({ ...base, ...overrides }));
}

/** The JSON body the action actually sent. */
function sentBody(): Record<string, unknown> {
  const call = apiFetch.mock.calls[0];
  if (!call) throw new Error("apiFetch was not called");
  return JSON.parse((call[2] as { body: string }).body) as Record<string, unknown>;
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ json: async () => ({ id: "inv-1" }) });
  redirect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createInvoice — the amount that reaches the API", () => {
  it("sends integer minor units for a two-decimal currency", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await createInvoice({}, validForm({ amount: "1234.56", currency: "GBP" }));
    expect(sentBody().amountMinorUnits).toBe(123_456);
  });

  it("sends THREE-decimal minor units for a Kuwaiti invoice", async () => {
    // 12.345 KWD is 12345 fils. Under a hard-coded ×100 this would be 1234 or
    // rejected outright — which is what the pre-1.6c importer did.
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await createInvoice({}, validForm({ amount: "12.345", currency: "KWD" }));
    expect(sentBody().amountMinorUnits).toBe(12_345);
    expect(sentBody().currency).toBe("KWD");
  });

  it("sends the yen unscaled, because the minor unit IS the yen", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await createInvoice({}, validForm({ amount: "450000", currency: "JPY" }));
    expect(sentBody().amountMinorUnits).toBe(450_000);
  });

  it("reads the CURRENCY before judging the amount", async () => {
    // The same string is right or wrong depending on another field on the same
    // form: 12.345 is a valid Kuwaiti amount and an invalid British one.
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const refused = await createInvoice({}, validForm({ amount: "12.345", currency: "GBP" }));
    expect(refused.error).toMatch(/GBP/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("accepts a lowercase currency instead of bouncing it off the API", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await createInvoice({}, validForm({ currency: "aed", amount: "10.00" }));
    expect(sentBody().currency).toBe("AED");
    expect(sentBody().amountMinorUnits).toBe(1000);
  });
});

describe("createInvoice — refusals that never reach the API", () => {
  it("refuses zero", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ amount: "0" }));
    expect(state.error).toMatch(/more than zero/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses a negative amount", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ amount: "-50.00" }));
    expect(state.error).toMatch(/positive/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses a currency that is not three letters", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ currency: "POUNDS" }));
    expect(state.error).toMatch(/three-letter/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("requires an invoice number and a due date", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    expect((await createInvoice({}, validForm({ invoiceNumber: "  " }))).error).toMatch(/number/i);
    apiFetch.mockClear();
    expect((await createInvoice({}, validForm({ dueDate: "" }))).error).toMatch(/due/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses an invoice due before it was raised", async () => {
    // A typo every time, and the API has no opinion on it.
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice(
      {},
      validForm({ issueDate: "2026-10-01", dueDate: "2026-09-30" }),
    );
    expect(state.error).toMatch(/due date/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("createInvoice — a refusal must not throw away what was typed", () => {
  /**
   * ⚠️ FOUND ON SCREEN, NOT BY A TEST. React 19 resets an uncontrolled form
   * once its action returns, so the first version emptied every field the
   * moment it said "KWD amounts have at most 3 decimal places" — deleting the
   * amount it was complaining about, along with the invoice number and dates
   * that were perfectly fine.
   */
  it("hands back every field when the amount is refused", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice(
      {},
      validForm({
        invoiceNumber: "INV-4003",
        amount: "987.6543",
        currency: "KWD",
        issueDate: "2026-08-01",
        dueDate: "2026-09-30",
        status: "active",
      }),
    );
    expect(state.error).toMatch(/3 decimal places/);
    // Including the offending amount itself — otherwise the advice is unusable.
    expect(state.values?.amount).toBe("987.6543");
    expect(state.values?.invoiceNumber).toBe("INV-4003");
    expect(state.values?.currency).toBe("KWD");
    expect(state.values?.issueDate).toBe("2026-08-01");
    expect(state.values?.dueDate).toBe("2026-09-30");
    expect(state.values?.status).toBe("active");
  });

  it("hands them back when the API refuses too", async () => {
    // A duplicate invoice number is where it matters most: everything else the
    // customer typed was fine.
    const { ApiError } = await import("../src/lib/api");
    apiFetch.mockRejectedValueOnce(new ApiError("Invoice number already used", 409));
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ amount: "50.00" }));
    expect(state.error).toMatch(/already used/);
    expect(state.values?.amount).toBe("50.00");
  });

  it("does NOT hand them back on success, so the next invoice starts blank", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm());
    expect(state.success).toBeTruthy();
    expect(state.values).toBeUndefined();
  });
});

describe("createInvoice — what it says afterwards", () => {
  it("says a draft will NOT be chased", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ status: "draft" }));
    expect(sentBody().status).toBe("draft");
    expect(state.success).toMatch(/draft/i);
    expect(state.success).toMatch(/won't be chased|not be chased/i);
  });

  it("says an issued invoice WILL be chased, because that is the consequence", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ status: "active" }));
    expect(sentBody().status).toBe("active");
    expect(state.success).toMatch(/chase/i);
  });

  it("treats any unexpected status as a draft rather than starting a chase", async () => {
    // Fail safe: a server action is reachable by direct POST, and the harmful
    // direction is starting to chase somebody by accident.
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await createInvoice({}, validForm({ status: "paid" }));
    expect(sentBody().status).toBe("draft");
  });

  it("omits optional fields rather than sending blanks the API must reject", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await createInvoice({}, validForm());
    expect(sentBody()).not.toHaveProperty("contactId");
    expect(sentBody()).not.toHaveProperty("issueDate");
  });

  it("passes the API's own message through when it refuses", async () => {
    const { ApiError } = await import("../src/lib/api");
    apiFetch.mockRejectedValueOnce(new ApiError("Invoice number already used", 409));
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm());
    expect(state.error).toBe("Invoice number already used");
  });
});
