"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { normalisePhoneInput, parseAmountInput } from "@/lib/money";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

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

  revalidatePath("/app/invoices");
  return {
    success:
      values.status === "active"
        ? `${values.invoiceNumber} added for ${values.clientName}. Eva starts chasing three days before it falls due.`
        : `${values.invoiceNumber} added for ${values.clientName} as a draft. It won't be chased until you start it.`,
  };
}
