"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { normalisePhoneInput, parseAmountInput } from "@/lib/money";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * The book's address, built from the catalogue rather than typed out.
 *
 * ⚠️ THE REFRESHES BELOW NAMED A PATH THAT IS NOT A ROUTE. Written by hand as
 * `/app/invoices`, they stopped matching anything when the products got their
 * own URLs. What is certain is that they cleared nothing: there is no cache
 * entry under an address Next does not serve. What a customer actually saw is
 * NOT established — the book is server-rendered on demand, so how stale it
 * looked depends on the client router's cache, and nobody has reproduced it.
 * Stated this way on purpose: the defect is provable, the symptom is not.
 */
const BOOK = moduleHref("email_credit_controller", "invoices");

/**
 * Adding a row to the book by typing it (slice 1.6c).
 *
 * ⚠️ ONE REQUEST, NOT THREE. The whole point of the founder's table is that
 * "add the client, then find them again, then add the invoice" stops being the
 * journey. The API resolves or creates the client and the contact in the same
 * transaction as the invoice, using the SAME code the CSV importer uses — so a
 * typed row and an uploaded row land in the same place.
 *
 * ⚠️ A "use server" FILE MAY ONLY EXPORT ASYNC FUNCTIONS. Types are declared
 * here and exported as types (erased at build); constants live in `lib/`. A
 * plain exported constant is a runtime 500 that typecheck and lint both pass —
 * learned the hard way on the upload screen.
 */

export interface AddRowState {
  error?: string;
  success?: string;
  /** Echoed back on refusal — React 19 empties the form otherwise. */
  values?: Record<string, string>;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export async function addBookRow(
  _prevState: AddRowState,
  formData: FormData,
): Promise<AddRowState> {
  const organisationId = text(formData, "organisationId");
  /**
   * Present only when an EXISTING client was chosen from the picker.
   *
   * ⚠️ NOT ECHOED BACK IN `values`, and it does not need to be. `values`
   * exists because React 19 empties UNCONTROLLED fields when an action
   * returns; the picker holds its choice in React state and its input is
   * controlled, so both survive a refusal on their own.
   */
  const customerId = text(formData, "customerId");
  const currency = text(formData, "currency").toUpperCase() || "GBP";
  const values: Record<string, string> = {
    clientName: text(formData, "clientName"),
    contactName: text(formData, "contactName"),
    contactEmail: text(formData, "contactEmail"),
    contactPhone: text(formData, "contactPhone"),
    invoiceNumber: text(formData, "invoiceNumber"),
    amount: String(formData.get("amount") ?? ""),
    currency,
    issueDate: text(formData, "issueDate"),
    dueDate: text(formData, "dueDate"),
    status: text(formData, "status") === "active" ? "active" : "draft",
  };
  const refuse = (error: string): AddRowState => ({ error, values });

  if (values.clientName === "") return refuse("Enter the client's name.");
  if (!/^[A-Z]{3}$/.test(currency)) {
    return refuse("Currency must be a three-letter code, like GBP or AED.");
  }

  // The currency is read BEFORE the amount, because 12.345 is a valid Kuwaiti
  // amount and an invalid British one.
  const amount = parseAmountInput(values.amount, currency);
  if (!amount.ok) return refuse(amount.message);

  if (values.invoiceNumber === "") return refuse("Enter the invoice number.");
  if (values.dueDate === "") return refuse("Enter the date this invoice is due.");
  if (values.issueDate !== "" && values.issueDate > values.dueDate) {
    return refuse("The due date can't be before the invoice date.");
  }

  /**
   * ⚠️ THE PHONE IS NORMALISED HERE AND REFUSED IF IT CANNOT BE. The API takes
   * E.164 only, because a dialler cannot ring "07700 900123" without knowing
   * the country — so a bare national number is turned away with an explanation
   * rather than stored as something the calling agent will choke on later.
   */
  let phone: string | undefined;
  if (values.contactPhone !== "") {
    const normalised = normalisePhoneInput(values.contactPhone);
    if (normalised === null) {
      return refuse(
        "Add the country code to the phone number, like +44 7700 900123 or +971 50 123 4567.",
      );
    }
    phone = normalised;
  }

  // A contact with no email is somebody Eva cannot write to. Allowed — you may
  // not have it yet — but the row will say so, so this is not refused here.
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/invoices`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // An id when one was picked; the API then ignores the name for
        // matching and uses it only if it has to create the client.
        ...(customerId ? { customerId } : {}),
        clientName: values.clientName,
        ...(values.contactName ? { contactName: values.contactName } : {}),
        ...(values.contactEmail ? { contactEmail: values.contactEmail } : {}),
        ...(phone ? { contactPhone: phone } : {}),
        invoiceNumber: values.invoiceNumber,
        amountMinorUnits: amount.minorUnits,
        currency,
        ...(values.issueDate ? { issueDate: values.issueDate } : {}),
        dueDate: values.dueDate,
        status: values.status,
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      // A 403 becomes a sentence; everything else keeps the API's own wording,
      // which is where "amount 'x' is not a valid positive GBP amount" and the
      // duplicate-number refusal live. See `lib/permissions.ts`.
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "add-row") ?? error.message)
          : "Something went wrong. Please try again.",
      values,
    };
  }

  revalidatePath(BOOK);
  return {
    success:
      values.status === "active"
        ? `${values.invoiceNumber} added for ${values.clientName}. Eva starts chasing three days before it falls due.`
        : `${values.invoiceNumber} added for ${values.clientName} as a draft. It won't be chased until you start it.`,
  };
}
