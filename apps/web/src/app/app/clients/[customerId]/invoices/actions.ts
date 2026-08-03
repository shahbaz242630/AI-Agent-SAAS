"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { parseAmountInput } from "@/lib/money";
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

function failed(error: unknown, values: SubmittedInvoice): InvoiceActionState {
  return {
    error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    // An API refusal — a duplicate invoice number, say — is the case where
    // keeping the typing matters most: everything else on the form was fine.
    values,
  };
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

  // Uppercased here so "aed" typed in a hurry is not refused by the API's
  // `^[A-Z]{3}$` — a case difference is not a mistake worth a round trip.
  const currency = String(formData.get("currency") ?? "GBP")
    .trim()
    .toUpperCase();
  const status = String(formData.get("status") ?? "draft") === "active" ? "active" : "draft";
  const invoiceNumber = String(formData.get("invoiceNumber") ?? "").trim();
  const dueDate = optional(formData, "dueDate");
  const issueDate = optional(formData, "issueDate");

  // Captured BEFORE any refusal so every early return can hand it back.
  const values: SubmittedInvoice = {
    invoiceNumber,
    amount: String(formData.get("amount") ?? ""),
    currency,
    issueDate: issueDate ?? "",
    dueDate: dueDate ?? "",
    contactId: optional(formData, "contactId") ?? "",
    status,
  };
  const refuse = (error: string): InvoiceActionState => ({ error, values });

  if (!/^[A-Z]{3}$/.test(currency)) {
    return refuse("Currency must be a three-letter code, like GBP or AED.");
  }

  const amount = parseAmountInput(values.amount, currency);
  if (!amount.ok) return refuse(amount.message);

  if (invoiceNumber === "") return refuse("Enter the invoice number.");
  if (!dueDate) return refuse("Enter the date this invoice is due.");

  // Caught here rather than at the API because the API has no opinion on it,
  // and an invoice due before it was raised is a typo every time.
  if (issueDate && issueDate > dueDate) {
    return refuse("The due date can't be before the invoice date.");
  }

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
          invoiceNumber,
          amountMinorUnits: amount.minorUnits,
          currency,
          dueDate,
          ...(issueDate ? { issueDate } : {}),
          ...(optional(formData, "contactId")
            ? { contactId: optional(formData, "contactId") }
            : {}),
          status,
        }),
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error, values);
  }

  revalidatePath(`/app/clients/${customerId}/invoices`);
  // Saying WHICH state it landed in matters: "active" means Eva will start
  // chasing it, and that is not something to discover later.
  return {
    success:
      status === "active"
        ? `Invoice ${invoiceNumber} added. Eva will chase it from its due date.`
        : `Invoice ${invoiceNumber} saved as a draft. It won't be chased until you issue it.`,
  };
}
