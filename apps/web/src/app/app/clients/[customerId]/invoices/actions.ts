"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import {
  invoiceActionSuccess,
  isInvoiceLifecycleAction,
  paymentRecordedLine,
} from "@/lib/invoice-lifecycle";
import { formatMoney, parseAmountInput } from "@/lib/money";
import { humanRefusal, type WriteAction } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Invoice actions (slice 1.6c, task 3).
 *
 * The browser never talks to the API directly — authorisation is the API's job,
 * which matters because a server action is reachable by direct POST and not
 * only through our own form. Everything validated here is validated again
 * there; this layer exists to produce a sentence a human can act on, not to be
 * the gate.
 */

/**
 * What the user typed, echoed back so a refusal does not throw it away.
 *
 * ⚠️ NOT COSMETIC. React 19 RESETS an uncontrolled form once its action
 * returns, so without this every field empties the moment we say "KWD amounts
 * have at most 3 decimal places" — including the amount being complained
 * about. The customer is told what to fix and simultaneously loses the thing
 * they were fixing, which is worse than no message at all. Seen on screen
 * 2026-08-03; no test would have shown it.
 *
 * Deliberately ABSENT on success, so the form clears and the next invoice
 * starts blank rather than inheriting the last one.
 */
export interface SubmittedInvoice {
  invoiceNumber: string;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  contactId: string;
  status: string;
}

export interface InvoiceActionState {
  error?: string;
  success?: string;
  values?: SubmittedInvoice;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function optional(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function failed(error: unknown, values: SubmittedInvoice, action: WriteAction): InvoiceActionState {
  return {
    error: refusalMessage(error, action),
    // An API refusal — a duplicate invoice number, say — is the case where
    // keeping the typing matters most: everything else on the form was fine.
    values,
  };
}

/**
 * The API's message, unless it is a 403 (slice 1.6c, task 8).
 *
 * ⚠️ ONLY 403 IS REWRITTEN, and that boundary is the whole design. The API's
 * other 4xx messages are written for people and carry detail this layer does
 * not have — "INV-3001 has already changed since this page was loaded",
 * "KWD amounts have at most 3 decimal places", "Microsoft authorisation
 * expired". Replacing those wholesale is defect F4, where a real instruction
 * became "unexpected error (400). Please try again." A 403 is the one case
 * where the API's string is deliberately for a log —
 * `Role 'sales' lacks permission 'invoices:write' in this organisation` — and
 * asking a credit controller to parse a permission key to learn that they
 * should ask their manager is not an answer.
 *
 * This should now be rare: the controls are hidden from roles that cannot use
 * them. It stays because a server action is reachable by direct POST, and
 * because a role can be changed in another tab while a page sits open.
 */
function refusalMessage(error: unknown, action: WriteAction): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Please try again.";
  return humanRefusal(error.status, action) ?? error.message;
}

/** Everything both invoice forms collect, read once so a refusal can echo it. */
function readSubmitted(formData: FormData): SubmittedInvoice {
  return {
    invoiceNumber: String(formData.get("invoiceNumber") ?? "").trim(),
    amount: String(formData.get("amount") ?? ""),
    // Uppercased here so "aed" typed in a hurry is not refused by the API's
    // `^[A-Z]{3}$` — a case difference is not a mistake worth a round trip.
    currency: String(formData.get("currency") ?? "GBP")
      .trim()
      .toUpperCase(),
    issueDate: optional(formData, "issueDate") ?? "",
    dueDate: optional(formData, "dueDate") ?? "",
    contactId: optional(formData, "contactId") ?? "",
    status: String(formData.get("status") ?? "draft") === "active" ? "active" : "draft",
  };
}

/**
 * The checks raising and editing an invoice have in common → the amount in
 * minor units, or the sentence to show instead.
 *
 * ⚠️ SHARED ON PURPOSE, AND THE ORDER IS PART OF IT. The currency is judged
 * BEFORE the amount because `12.345` is a valid Kuwaiti amount and an invalid
 * British one — the same string is right or wrong depending on another field on
 * the same form. Two copies of this sequence would eventually disagree about
 * which of two mistakes to name first, and the edit form would tell someone
 * something different from the form that created the same invoice.
 */
function checkSubmitted(values: SubmittedInvoice): { minorUnits: number } | { error: string } {
  if (!/^[A-Z]{3}$/.test(values.currency)) {
    return { error: "Currency must be a three-letter code, like GBP or AED." };
  }

  const amount = parseAmountInput(values.amount, values.currency);
  if (!amount.ok) return { error: amount.message };

  if (values.invoiceNumber === "") return { error: "Enter the invoice number." };
  if (values.dueDate === "") return { error: "Enter the date this invoice is due." };

  // Caught here rather than at the API because the API has no opinion on it,
  // and an invoice due before it was raised is a typo every time.
  if (values.issueDate !== "" && values.issueDate > values.dueDate) {
    return { error: "The due date can't be before the invoice date." };
  }

  return { minorUnits: amount.minorUnits };
}

/**
 * Raise an invoice.
 *
 * ⚠️ THE AMOUNT IS THE RISKY FIELD, and it is converted in exactly one place.
 * The form collects a decimal string — what a person actually types — and
 * `parseAmountInput` turns it into integer minor units using the shared
 * `@eva/types` implementation. There is no `* 100` here, and there must never
 * be: the number of digits in a minor unit belongs to the CURRENCY, so the
 * conversion cannot be done without knowing which currency was chosen.
 *
 * ⚠️ THE CURRENCY IS READ BEFORE THE AMOUNT for that reason. `12.345` is a
 * valid Kuwaiti amount and an invalid British one; the same string is right or
 * wrong depending on a different field on the same form.
 */
export async function createInvoice(
  _prevState: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");

  // Captured BEFORE any refusal so every early return can hand it back.
  const values = readSubmitted(formData);
  const checked = checkSubmitted(values);
  if ("error" in checked) return { error: checked.error, values };

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/customers/${customerId}/invoices`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: values.invoiceNumber,
          amountMinorUnits: checked.minorUnits,
          currency: values.currency,
          dueDate: values.dueDate,
          ...(values.issueDate ? { issueDate: values.issueDate } : {}),
          ...(values.contactId ? { contactId: values.contactId } : {}),
          status: values.status,
        }),
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error, values, "create-invoice");
  }

  // BOTH screens, because both can start this: the client's own page and the
  // org-wide book. Revalidating only the one the click came from leaves the
  // other showing a status that is no longer true.
  revalidatePath(`/app/clients/${customerId}/invoices`);
  revalidatePath("/app/invoices");
  /**
   * Saying WHICH state it landed in matters: "active" means Eva starts
   * chasing, and that is not something to discover later.
   *
   * ⚠️ NOT "from its due date", which is what this said until task 4 checked
   * it. The default sequence's first email goes THREE DAYS BEFORE the due date
   * (`DEFAULT_REMINDER_STEPS`), so that sentence promised the client would not
   * hear from Eva until the money was late, and they will. Founder ruled on
   * 2026-08-04 that the pre-due nudge STAYS — it is the most effective chaser
   * there is, because it arrives before the client has done anything wrong — so
   * every screen has to say plainly that it happens.
   */
  return {
    success:
      values.status === "active"
        ? `Invoice ${values.invoiceNumber} added. Eva starts chasing three days before it falls due.`
        : `Invoice ${values.invoiceNumber} saved as a draft. It won't be chased until you start it.`,
  };
}

/**
 * Edit a DRAFT invoice (slice 1.6c, task 4).
 *
 * `PATCH` is draft-only in the API and the screen does not offer the form on
 * anything else (trap 4) — but this is checked there too, because a server
 * action is reachable by direct POST and the API's 409 is the real gate.
 *
 * ⚠️ THE REFUSAL STILL HAS TO HAND BACK WHAT WAS TYPED, and it is easy to think
 * otherwise here. On the ADD form a React 19 reset empties the fields; on this
 * one it quietly restores the invoice's ORIGINAL values, so a rejected edit
 * looks like it simply did not happen. That is worse: nothing is obviously
 * wrong, so the natural response is to assume it saved.
 */
export async function updateInvoice(
  _prevState: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const invoiceId = String(formData.get("invoiceId") ?? "");

  const values = readSubmitted(formData);
  const checked = checkSubmitted(values);
  if ("error" in checked) return { error: checked.error, values };

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  /**
   * ⚠️ `contactId` IS ONLY SENT WHEN THE FORM ACTUALLY OFFERED THE FIELD.
   *
   * An absent field means "leave the recipient alone" and an explicit null
   * means "nobody" — so sending null unconditionally would be a silent wipe for
   * any user whose role cannot read contacts, because the page omits the picker
   * for them (that fetch has its own `try` for exactly this reason). They would
   * change an amount and remove the reminder recipient without being told.
   *
   * The marker is a hidden input rendered beside the picker, so the two can
   * only be present together.
   */
  const offeredContactPicker = formData.get("contactPicker") !== null;

  try {
    await apiFetch(
      `/organisations/${organisationId}/customers/${customerId}/invoices/${invoiceId}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: values.invoiceNumber,
          amountMinorUnits: checked.minorUnits,
          currency: values.currency,
          dueDate: values.dueDate,
          ...(values.issueDate ? { issueDate: values.issueDate } : {}),
          ...(offeredContactPicker ? { contactId: values.contactId || null } : {}),
        }),
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error, values, "edit-invoice");
  }

  // BOTH screens, because both can start this: the client's own page and the
  // org-wide book. Revalidating only the one the click came from leaves the
  // other showing a status that is no longer true.
  revalidatePath(`/app/clients/${customerId}/invoices`);
  revalidatePath("/app/invoices");
  return { success: `Invoice ${values.invoiceNumber} saved. It is still a draft.` };
}

/**
 * Record money received against an invoice (slice 1.6c, task 6).
 *
 * ⚠️ THE AMOUNT IS PARSED WITH THE INVOICE'S OWN CURRENCY, not the
 * organisation's and not a default. A payment against a Kuwaiti invoice is in
 * fils and takes three decimals; the same string against a yen invoice is not
 * an amount at all. The currency comes from a hidden field carrying what the
 * row displayed — and the API validates the number independently, so the worst
 * a tampered field can do is produce a refusal here or there.
 *
 * ⚠️ THERE IS NO "MARK AS PAID" and this action must never become one. The
 * status follows the money: the API decides `partially_paid` or `paid` from the
 * resulting balance, inside the state machine, in the transaction that writes
 * the amount.
 */
export interface PaymentActionState {
  error?: string;
  success?: string;
  /** Echoed back on a refusal — React 19 empties the form otherwise. */
  amount?: string;
}

export async function recordPayment(
  _prevState: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const currency = String(formData.get("currency") ?? "GBP")
    .trim()
    .toUpperCase();
  const paidAt = optional(formData, "paidAt");
  const amount = String(formData.get("amount") ?? "");

  const parsed = parseAmountInput(amount, currency);
  if (!parsed.ok) return { error: parsed.message, amount };

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  let invoice: {
    invoiceNumber?: string;
    status?: string;
    outstandingMinorUnits?: number;
    currency?: string;
    chaseBlockedReason?: string | null;
  };
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/customers/${customerId}/invoices/${invoiceId}/payments`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountMinorUnits: parsed.minorUnits,
          ...(paidAt ? { paidAt } : {}),
        }),
      },
    );
    invoice = (await response.json()) as typeof invoice;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return { error: refusalMessage(error, "record-payment"), amount };
  }

  // BOTH screens, because both can start this: the client's own page and the
  // org-wide book. Revalidating only the one the click came from leaves the
  // other showing a status that is no longer true.
  revalidatePath(`/app/clients/${customerId}/invoices`);
  revalidatePath("/app/invoices");

  /**
   * ⚠️ THE OUTCOME IS DESCRIBED FROM THE API'S ANSWER, not from what was sent.
   * Whether this cleared the invoice, left a balance Eva keeps chasing, or left
   * a balance nobody is chasing because it is paused, is the server's fact —
   * and it is the only part of this the customer actually needs.
   */
  const outstanding = invoice.outstandingMinorUnits ?? 0;
  const invoiceCurrency = invoice.currency ?? currency;
  return {
    success: paymentRecordedLine({
      invoiceNumber: invoice.invoiceNumber ?? "That invoice",
      status: invoice.status ?? "active",
      outstandingMinorUnits: outstanding,
      formattedOutstanding: formatMoney(outstanding, invoiceCurrency),
      chaseBlockedReason: invoice.chaseBlockedReason ?? null,
    }),
  };
}

/**
 * Run one of the four lifecycle actions (slice 1.6c, task 4).
 *
 * The consequence was stated before the click by `invoice-lifecycle.ts`; this
 * carries it out and says what happened.
 */
export async function runInvoiceAction(
  _prevState: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const invoiceNumber = String(formData.get("invoiceNumber") ?? "").trim();
  const action = String(formData.get("action") ?? "");

  /**
   * ⚠️ FAIL CLOSED ON THE ACTION NAME. A server action is a POST endpoint, so
   * this string is not necessarily one of our four buttons — without the guard
   * it would be interpolated straight into an API path. The API would refuse
   * an unknown one with a 404, but building a URL out of unchecked input is not
   * something to leave to the far end.
   */
  if (!isInvoiceLifecycleAction(action)) {
    return { error: "That isn't something you can do to an invoice." };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  /**
   * Whether anything will actually be sent — read from the API's OWN response
   * to the transition, not from a hidden field on the form.
   *
   * `activate` and `resume` schedule ZERO reminders whenever the scheduler
   * refuses the invoice, and both still return 200. Saying "Eva will chase it"
   * there contradicts the warning the confirm panel gave one click earlier.
   */
  let chaseBlockedReason: string | null = null;

  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/customers/${customerId}/invoices/${invoiceId}/${action}`,
      accessToken,
      { method: "POST" },
    );
    try {
      const invoice = (await response.json()) as { chaseBlockedReason?: string | null };
      chaseBlockedReason = invoice.chaseBlockedReason ?? null;
    } catch {
      // The transition SUCCEEDED; only the body was unreadable. Claim no
      // blocker rather than inventing an alarm — the cautious direction here is
      // not to shout, because the action itself worked.
      chaseBlockedReason = null;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    /**
     * A 409 here is the state machine refusing an illegal move, and its message
     * — "Invoice cannot 'pause' from status 'draft'" — is a sentence for us,
     * not for a customer. It means one thing in practice: the page is showing
     * an invoice that has since changed, usually in another tab.
     */
    if (error instanceof ApiError && error.status === 409) {
      return {
        error: `${invoiceNumber || "That invoice"} has already changed since this page was loaded. Refresh to see where it is now.`,
      };
    }
    return { error: refusalMessage(error, "change-invoice") };
  }

  // BOTH screens, because both can start this: the client's own page and the
  // org-wide book. Revalidating only the one the click came from leaves the
  // other showing a status that is no longer true.
  revalidatePath(`/app/clients/${customerId}/invoices`);
  revalidatePath("/app/invoices");
  return {
    success: invoiceActionSuccess(action, invoiceNumber || "That invoice", { chaseBlockedReason }),
  };
}
