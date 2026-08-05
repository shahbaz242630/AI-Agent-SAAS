import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `addBookRow` — typing a row straight into the book (slice 1.6c).
 *
 * ⚠️ WHAT THESE DEFEND: the BODY that reaches the API. One request has to carry
 * the client, the contact and the invoice, because the founder's whole
 * complaint was the three-step journey. `@eva/types` is not mocked, so the
 * amount conversion is the real one.
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

function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  const base: Record<string, string> = {
    organisationId: "org-1",
    clientName: "Harbour Freight Ltd",
    invoiceNumber: "ROW-1",
    amount: "1234.56",
    currency: "GBP",
    dueDate: "2026-09-30",
    status: "draft",
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) data.append(key, value);
  return data;
}

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

describe("one request, not three", () => {
  it("sends the client, the contact and the invoice together", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    await addBookRow(
      {},
      form({
        clientName: "Harbour Freight Ltd",
        contactName: "Priya Raman",
        contactEmail: "priya@harbour.example",
        contactPhone: "+44 7700 900123",
      }),
    );
    const call = apiFetch.mock.calls[0]!;
    // The ORG-wide route, not one nested under a customer that may not exist.
    expect(call[0]).toBe("/organisations/org-1/invoices");
    expect(sentBody()).toMatchObject({
      clientName: "Harbour Freight Ltd",
      contactName: "Priya Raman",
      contactEmail: "priya@harbour.example",
      invoiceNumber: "ROW-1",
      amountMinorUnits: 123_456,
      currency: "GBP",
      status: "draft",
    });
  });

  it("converts the amount with the currency chosen on the same form", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    await addBookRow({}, form({ amount: "12.345", currency: "KWD" }));
    expect(sentBody().amountMinorUnits).toBe(12_345);
  });

  it("reads the currency BEFORE judging the amount", async () => {
    // 12.345 is a valid Kuwaiti amount and an invalid British one.
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form({ amount: "12.345", currency: "GBP" }));
    expect(state.error).toMatch(/GBP/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("the phone number", () => {
  /**
   * ⚠️ REFUSED, NOT GUESSED. A dialler cannot ring "07700 900123" without
   * knowing the country, and assuming the customer's own would be wrong for the
   * case Eva exists for — a UK business chasing a buyer in Singapore.
   */
  it("refuses a national number and says what is missing", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form({ contactPhone: "07700 900123" }));
    expect(state.error).toMatch(/country code/i);
    expect(apiFetch).not.toHaveBeenCalled();
    // And the typing survives the refusal.
    expect(state.values?.contactPhone).toBe("07700 900123");
  });

  it("sends E.164 with the human formatting stripped", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    await addBookRow({}, form({ contactPhone: "+971 (50) 123-4567" }));
    expect(sentBody().contactPhone).toBe("+971501234567");
  });

  it("omits it entirely when it was left blank", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    await addBookRow({}, form({ contactPhone: "" }));
    expect(sentBody()).not.toHaveProperty("contactPhone");
  });
});

describe("refusals that never reach the API", () => {
  it("requires a client name, an invoice number and a due date", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    expect((await addBookRow({}, form({ clientName: " " }))).error).toMatch(/client/i);
    expect((await addBookRow({}, form({ invoiceNumber: "" }))).error).toMatch(/number/i);
    expect((await addBookRow({}, form({ dueDate: "" }))).error).toMatch(/due/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses zero and negative amounts", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    expect((await addBookRow({}, form({ amount: "0" }))).error).toMatch(/more than zero/i);
    expect((await addBookRow({}, form({ amount: "-5" }))).error).toMatch(/positive/i);
  });

  it("refuses an invoice due before it was raised", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form({ issueDate: "2026-10-01", dueDate: "2026-09-30" }));
    expect(state.error).toMatch(/due date/i);
  });

  it("hands back every field when it refuses", async () => {
    // React 19 empties an uncontrolled form when the action returns.
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form({ amount: "nonsense", clientName: "Acme" }));
    expect(state.values?.clientName).toBe("Acme");
    expect(state.values?.amount).toBe("nonsense");
    expect(state.values?.invoiceNumber).toBe("ROW-1");
  });
});

describe("what it says afterwards", () => {
  it("says a draft will not be chased", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form({ status: "draft" }));
    expect(state.success).toMatch(/draft/i);
    expect(state.success).toMatch(/won't be chased/i);
  });

  it("says WHEN an active one starts, because it starts before the due date", async () => {
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form({ status: "active" }));
    expect(state.success).toMatch(/three days before/i);
  });

  it("treats an unexpected status as a draft rather than starting a chase", async () => {
    // A server action is reachable by direct POST; the harmful direction is
    // emailing somebody's client by accident.
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    await addBookRow({}, form({ status: "paid" }));
    expect(sentBody().status).toBe("draft");
  });

  it("passes the API's refusal through — an ambiguous client, or a duplicate number", async () => {
    const { ApiError } = await import("../src/lib/api");
    apiFetch.mockRejectedValueOnce(
      new ApiError("More than one client is called 'Acme'. Open the client you mean.", 409),
    );
    const { addBookRow } = await import("../src/app/app/invoices/add-row-actions");
    const state = await addBookRow({}, form());
    expect(state.error).toMatch(/more than one client/i);
    expect(state.values?.clientName).toBeTruthy();
  });
});
