"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Invoice settings (slice 1.6c, task 13).
 *
 * ⚠️ A "use server" FILE MAY ONLY EXPORT ASYNC FUNCTIONS. Types are exported as
 * types (erased at build); constants live in `lib/`. A plain exported constant
 * is a runtime 500 that typecheck and lint both pass — learned on the upload
 * screen.
 */

export interface SettingsActionState {
  error?: string;
  success?: string;
  /** Echoed back on a refusal — React 19 empties the form otherwise. */
  submitted?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Set the currency a new invoice's form opens on.
 *
 * ⚠️ THIS CHANGES A DEFAULT AND NOTHING ELSE (founder ruling 2026-08-04). No
 * existing invoice is touched, re-priced or re-read: every invoice carries its
 * own currency, and that is the only one the money layer ever uses. Saying so
 * in the success line matters — "default currency" is exactly the phrase a
 * customer could reasonably fear means "convert my book".
 */
export async function setDefaultCurrency(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  /**
   * Uppercased HERE, not at the API. The money layer indexes its minor-unit
   * table by exact ISO 4217 code, so `aed` would miss and silently take the
   * 2-digit fallback — and the API refuses a lowercase code rather than
   * guessing. Fixing a case difference is this layer's job; it is not a mistake
   * worth a round trip.
   */
  const defaultCurrency = String(formData.get("defaultCurrency") ?? "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{3}$/.test(defaultCurrency)) {
    return {
      error: "A currency code is three letters, like GBP, AED or SGD.",
      submitted: defaultCurrency,
    };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/settings`, accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultCurrency }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "change-settings") ?? error.message)
          : "Something went wrong. Please try again.",
      submitted: defaultCurrency,
    };
  }

  // Every screen with an invoice form reads this off the organisation summary,
  // so both of them are now showing a stale default.
  revalidatePath("/app/settings/invoices");
  revalidatePath("/app/invoices");
  revalidatePath("/app/clients", "layout");

  return {
    success: `New invoices will start in ${defaultCurrency}. Invoices you have already raised are unchanged, and you can still pick any currency on any invoice.`,
  };
}
