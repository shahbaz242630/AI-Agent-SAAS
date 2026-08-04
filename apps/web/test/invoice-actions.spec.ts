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

/** The path and method the action actually called. */
function sentRequest(): { path: string; method: string } {
  const call = apiFetch.mock.calls[0];
  if (!call) throw new Error("apiFetch was not called");
  return { path: call[0] as string, method: (call[2] as { method: string }).method };
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

  it("says an issued invoice WILL be chased, and when it starts", async () => {
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ status: "active" }));
    expect(sentBody().status).toBe("active");
    expect(state.success).toMatch(/chasing/i);
    expect(state.success).toMatch(/three days before/i);
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

  it("does not promise the chase starts at the due date, because it starts before", async () => {
    /**
     * This sentence said "Eva will chase it from its due date" until task 4
     * checked `DEFAULT_REMINDER_STEPS` against it. The default sequence opens
     * with `pre_due_3`: the client is emailed THREE DAYS BEFORE the due date.
     * The copy was true of the status and false about the customer's client,
     * which is the shape of defect that reaches staging here.
     */
    const { createInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await createInvoice({}, validForm({ status: "active" }));
    // Founder ruled 2026-08-04 that the pre-due nudge stays, so every screen
    // has to say plainly that the client hears from Eva before the money is
    // late — it is the one thing about the schedule a customer must not learn
    // from their own client.
    expect(state.success).toMatch(/three days before/i);
    expect(state.success).not.toMatch(/from its due date/i);
  });
});

/** A complete, valid EDIT submission — same shape, plus the invoice id. */
function editForm(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    organisationId: "org-1",
    customerId: "cust-1",
    invoiceId: "inv-1",
    invoiceNumber: "INV-9001",
    amount: "1234.56",
    currency: "GBP",
    dueDate: "2026-09-30",
  };
  return form(Object.entries({ ...base, ...overrides }));
}

describe("updateInvoice — editing a draft (task 4)", () => {
  it("PATCHes the invoice, with the amount in minor units for its currency", async () => {
    const { updateInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await updateInvoice({}, editForm({ amount: "12.345", currency: "KWD" }));
    expect(sentRequest()).toEqual({
      path: "/organisations/org-1/customers/cust-1/invoices/inv-1",
      method: "PATCH",
    });
    expect(sentBody().amountMinorUnits).toBe(12_345);
  });

  it("never sends a status, because only the state machine may change one", async () => {
    // BRD 4.1 hard rule. The API rejects a status on a PATCH with a 400, so
    // sending one would break editing outright — but the reason it must not be
    // sent is the rule, not the error.
    const { updateInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await updateInvoice({}, editForm({ status: "active" }));
    expect(sentBody()).not.toHaveProperty("status");
  });

  it("applies the same refusals as raising one, in the same order", async () => {
    const { updateInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    // Currency before amount: 12.345 is valid KWD and invalid GBP.
    expect((await updateInvoice({}, editForm({ amount: "12.345" }))).error).toMatch(/GBP/);
    expect((await updateInvoice({}, editForm({ amount: "0" }))).error).toMatch(/more than zero/i);
    expect((await updateInvoice({}, editForm({ amount: "-5" }))).error).toMatch(/positive/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ THE REFUSAL MUST STILL ECHO WHAT WAS TYPED — and it is tempting to think
   * an edit form is safe because it has values to fall back on. It is not: a
   * React 19 reset restores the invoice's ORIGINAL values, so a rejected edit
   * silently looks like it never happened, which reads as success.
   */
  it("hands back what was typed when it refuses", async () => {
    const { updateInvoice } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await updateInvoice({}, editForm({ amount: "9.999", currency: "GBP" }));
    expect(state.values?.amount).toBe("9.999");
    expect(state.values?.invoiceNumber).toBe("INV-9001");
  });

  describe("the reminder recipient", () => {
    it("clears it with an explicit null when the picker offered 'nobody'", async () => {
      // Absent means "leave alone" on a PATCH, so "nobody" has to be said out
      // loud or picking the wrong person would be permanent.
      const { updateInvoice } =
        await import("../src/app/app/clients/[customerId]/invoices/actions");
      await updateInvoice({}, editForm({ contactPicker: "on", contactId: "" }));
      expect(sentBody().contactId).toBeNull();
    });

    it("sends the chosen contact", async () => {
      const { updateInvoice } =
        await import("../src/app/app/clients/[customerId]/invoices/actions");
      await updateInvoice({}, editForm({ contactPicker: "on", contactId: "contact-7" }));
      expect(sentBody().contactId).toBe("contact-7");
    });

    /**
     * ⚠️ THE SILENT WIPE THIS GUARD EXISTS FOR. The page fetches contacts in
     * its own `try`, so a role that cannot read them gets the form WITHOUT the
     * picker. If a missing field were read as "nobody", that user would change
     * an amount and delete the reminder recipient without being told.
     */
    it("leaves it alone entirely when the form never offered the picker", async () => {
      const { updateInvoice } =
        await import("../src/app/app/clients/[customerId]/invoices/actions");
      await updateInvoice({}, editForm());
      expect(sentBody()).not.toHaveProperty("contactId");
    });
  });
});

describe("recordPayment — the money that reaches the API (task 6)", () => {
  function paymentForm(overrides: Record<string, string> = {}) {
    return form(
      Object.entries({
        organisationId: "org-1",
        customerId: "cust-1",
        invoiceId: "inv-1",
        currency: "GBP",
        amount: "6000.00",
        ...overrides,
      }),
    );
  }

  /** A settled-or-not response, as the API would send it back. */
  function apiReturns(body: Record<string, unknown>) {
    apiFetch.mockResolvedValue({
      json: async () => ({
        invoiceNumber: "INV-3001",
        status: "partially_paid",
        currency: "GBP",
        chaseBlockedReason: null,
        ...body,
      }),
    });
  }

  it("POSTs to the payments endpoint with integer minor units", async () => {
    apiReturns({ outstandingMinorUnits: 400_000 });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await recordPayment({}, paymentForm());
    expect(sentRequest()).toEqual({
      path: "/organisations/org-1/customers/cust-1/invoices/inv-1/payments",
      method: "POST",
    });
    expect(sentBody().amountMinorUnits).toBe(600_000);
  });

  it("parses the amount in the INVOICE'S currency, not a default", async () => {
    // 500.000 KWD is 500000 fils. Judged as GBP the same string is invalid, and
    // judged as JPY it is not an amount at all.
    apiReturns({ outstandingMinorUnits: 487_654, currency: "KWD" });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await recordPayment({}, paymentForm({ currency: "KWD", amount: "500.000" }));
    expect(sentBody().amountMinorUnits).toBe(500_000);
  });

  it("refuses an amount with more decimals than the currency has", async () => {
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await recordPayment({}, paymentForm({ currency: "JPY", amount: "1000.50" }));
    expect(state.error).toMatch(/JPY/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses zero and negative payments before the API sees them", async () => {
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    expect((await recordPayment({}, paymentForm({ amount: "0" }))).error).toMatch(
      /more than zero/i,
    );
    expect((await recordPayment({}, paymentForm({ amount: "-50" }))).error).toMatch(/positive/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("hands the typed amount back when it is refused", async () => {
    // React 19 empties the form when the action returns, and the amount is the
    // one field the customer has to correct.
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await recordPayment({}, paymentForm({ amount: "12.3456" }));
    expect(state.amount).toBe("12.3456");
  });

  /**
   * ⚠️ NEVER A STATUS. There is no "mark as paid" in this product: the status
   * follows the money, decided by the API from the resulting balance inside the
   * state machine. A status on this payload would be an assertion with nothing
   * behind it.
   */
  it("sends no status, ever", async () => {
    apiReturns({ outstandingMinorUnits: 0, status: "paid" });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await recordPayment({}, paymentForm());
    expect(sentBody()).not.toHaveProperty("status");
  });

  it("omits the date rather than sending a blank one", async () => {
    apiReturns({ outstandingMinorUnits: 400_000 });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await recordPayment({}, paymentForm({ paidAt: "" }));
    expect(sentBody()).not.toHaveProperty("paidAt");
  });

  it("sends the date when one is given, because it is what makes DSO computable", async () => {
    apiReturns({ outstandingMinorUnits: 400_000 });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    await recordPayment({}, paymentForm({ paidAt: "2026-07-15" }));
    expect(sentBody().paidAt).toBe("2026-07-15");
  });

  it("describes the outcome from the API's answer, not from what was sent", async () => {
    // The customer paid part; the API says it is settled (they had already paid
    // some earlier). The message must follow the server.
    apiReturns({ outstandingMinorUnits: 0, status: "paid" });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await recordPayment({}, paymentForm({ amount: "10.00" }));
    expect(state.success).toMatch(/settled in full/i);
  });

  it("says the balance is still chased when one remains", async () => {
    apiReturns({ outstandingMinorUnits: 400_000 });
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await recordPayment({}, paymentForm());
    expect(state.success).toMatch(/keeps chasing/i);
    // Formatted with the invoice's currency, through the shared helper.
    expect(state.success).toContain("£4,000.00");
  });

  it("passes the API's refusal through — a draft, or a cancelled invoice", async () => {
    const { ApiError } = await import("../src/lib/api");
    apiFetch.mockRejectedValueOnce(
      new ApiError("This invoice is still a draft, so there is nothing to pay yet.", 409),
    );
    const { recordPayment } = await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await recordPayment({}, paymentForm());
    expect(state.error).toMatch(/still a draft/i);
  });
});

describe("runInvoiceAction — the four lifecycle buttons (task 4)", () => {
  function actionForm(action: string, overrides: Record<string, string> = {}) {
    return form(
      Object.entries({
        organisationId: "org-1",
        customerId: "cust-1",
        invoiceId: "inv-1",
        invoiceNumber: "INV-1001",
        action,
        ...overrides,
      }),
    );
  }

  it("POSTs to the action's own endpoint, never a status update", async () => {
    const { runInvoiceAction } =
      await import("../src/app/app/clients/[customerId]/invoices/actions");
    for (const action of ["activate", "pause", "resume", "cancel"]) {
      apiFetch.mockClear();
      apiFetch.mockResolvedValue({
        json: async () => ({ id: "inv-1", chaseBlockedReason: null }),
      });
      const state = await runInvoiceAction({}, actionForm(action));
      expect(sentRequest()).toEqual({
        path: `/organisations/org-1/customers/cust-1/invoices/inv-1/${action}`,
        method: "POST",
      });
      expect(state.success).toContain("INV-1001");
    }
  });

  /**
   * ⚠️ READ FROM THE API'S RESPONSE, NOT FROM THE FORM.
   *
   * Whether anybody gets emailed is the server's fact. Taking it from a hidden
   * field would mean the browser deciding what to claim about a chase — and the
   * page could be showing an invoice whose contact changed in another tab.
   */
  it("says nothing will be sent when the API reports a blocker", async () => {
    const { runInvoiceAction } =
      await import("../src/app/app/clients/[customerId]/invoices/actions");
    for (const action of ["activate", "resume"]) {
      for (const reason of ["no_contact", "no_email", "suppressed", "no_mailbox"]) {
        apiFetch.mockClear();
        apiFetch.mockResolvedValue({
          json: async () => ({ id: "inv-1", chaseBlockedReason: reason }),
        });
        const state = await runInvoiceAction({}, actionForm(action));
        expect(state.success).toMatch(/nothing will be sent/i);
        expect(state.success).not.toMatch(/reminder schedule/i);
      }
    }
  });

  it("does not turn an unreadable response body into a false alarm", async () => {
    // The transition SUCCEEDED; only the body could not be parsed. Shouting
    // "nothing will be sent" on the strength of a parse failure would be its
    // own kind of wrong.
    apiFetch.mockResolvedValue({
      json: async () => {
        throw new Error("not json");
      },
    });
    const { runInvoiceAction } =
      await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await runInvoiceAction({}, actionForm("activate"));
    expect(state.success).toMatch(/reminder schedule/i);
  });

  /**
   * ⚠️ FAIL CLOSED ON THE ACTION NAME. A server action is a POST endpoint
   * reachable without our form, and this value is interpolated into an API
   * path. The API would refuse an unknown one — but a URL should not be built
   * out of unchecked input in the first place.
   */
  it("refuses an action it does not recognise, without calling the API", async () => {
    const { runInvoiceAction } =
      await import("../src/app/app/clients/[customerId]/invoices/actions");
    for (const bogus of ["", "delete", "../../../organisations", "pay"]) {
      apiFetch.mockClear();
      const state = await runInvoiceAction({}, actionForm(bogus));
      expect(state.error).toBeTruthy();
      expect(apiFetch).not.toHaveBeenCalled();
    }
  });

  it("turns the state machine's 409 into something a human can act on", async () => {
    /**
     * The API says "Invoice cannot 'pause' from status 'draft'" — true, and a
     * sentence for us rather than for a customer. In practice a 409 here means
     * one thing: the page is showing an invoice that has since changed, usually
     * in another tab.
     */
    const { ApiError } = await import("../src/lib/api");
    apiFetch.mockRejectedValueOnce(new ApiError("Invoice cannot 'pause' from status 'draft'", 409));
    const { runInvoiceAction } =
      await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await runInvoiceAction({}, actionForm("pause"));
    expect(state.error).toMatch(/already changed/i);
    expect(state.error).toMatch(/refresh/i);
    expect(state.error).toContain("INV-1001");
    expect(state.error).not.toMatch(/status 'draft'/);
  });

  it("passes other API refusals through — they are already written for a human", async () => {
    // A 402 says the organisation does not have Invoice Chasing, which is
    // exactly what somebody needs to be told.
    const { ApiError } = await import("../src/lib/api");
    apiFetch.mockRejectedValueOnce(new ApiError("Module not entitled", 402));
    const { runInvoiceAction } =
      await import("../src/app/app/clients/[customerId]/invoices/actions");
    const state = await runInvoiceAction({}, actionForm("cancel"));
    expect(state.error).toBe("Module not entitled");
  });
});
