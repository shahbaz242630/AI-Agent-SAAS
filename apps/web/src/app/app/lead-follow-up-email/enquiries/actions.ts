"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { wallClockToInstant } from "@/products/lead-follow-up/lead-book";
import { createClient } from "@/lib/supabase/server";

/**
 * Logging an enquiry, and recording a request never to be contacted again
 * (Slice 3.1a).
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. The API writes the lead and its evidence in
 * one transaction, refuses a lead with no way to reach the person, and writes
 * the suppression list on every channel it holds. This layer moves a form to it
 * and turns what comes back into a sentence.
 */

/** Built from the catalogue, never written out — see `app-links.spec.ts`. */
const BOOK = moduleHref("lead_follow_up_email", "enquiries");

export interface LeadActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Log an enquiry that arrived some other way.
 *
 * ⚠️ `receivedAt` IS WHEN IT HAPPENED, NOT WHEN IT WAS TYPED, and the
 * conversion is the part that would go wrong in silence. The form sends
 * wall-clock digits with no timezone; our compute runs eight hours behind
 * London. `wallClockToInstant` reads them in the ORGANISATION's timezone —
 * see the reasoning and the tests on that function, because every
 * speed-to-lead figure this product will ever report is measured from here.
 */
export async function logEnquiry(
  _prevState: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const timezone = String(formData.get("timezone") ?? "Europe/London");

  const text = (key: string): string | undefined => {
    const value = String(formData.get(key) ?? "").trim();
    return value === "" ? undefined : value;
  };

  const contactEmail = text("contactEmail");
  const contactPhone = text("contactPhone");
  /**
   * Checked here as well as at the API and in the database, because the
   * alternative is a round trip to be told the obvious. The API's refusal is
   * still the one that counts.
   */
  if (!contactEmail && !contactPhone) {
    return { error: "Add an email address or a phone number, or Eva has no way to answer them." };
  }

  const receivedAtRaw = String(formData.get("receivedAt") ?? "");
  const receivedAt = wallClockToInstant(receivedAtRaw, timezone);
  if (!receivedAt) {
    return { error: "Choose when the enquiry came in." };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/leads`, accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: text("source") ?? "missed_call",
        ...(text("contactName") ? { contactName: text("contactName") } : {}),
        ...(contactEmail ? { contactEmail } : {}),
        ...(contactPhone ? { contactPhone } : {}),
        ...(text("enquiry") ? { enquiry: text("enquiry") } : {}),
        receivedAt,
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "log-lead") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  revalidatePath(BOOK);
  return { success: "Enquiry logged." };
}

/**
 * "Do not contact me again."
 *
 * ⚠️ THIS IS A COMPLIANCE ACTION, NOT A STATUS CHANGE, and the wording says so.
 * The API writes the suppression list on every channel it holds for this
 * person — BRD §4.3 requires it to be immediate, permanent and cross-channel —
 * so it reaches beyond this lead and beyond this product. There is no undo, and
 * the screen must not imply there is one.
 */
export async function stopContacting(
  _prevState: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const leadId = String(formData.get("leadId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/leads/${leadId}/do-not-contact`, accessToken, {
      method: "POST",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "stop-contacting") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  // Both: the book shows the state, and the detail page is what was acted on.
  revalidatePath(BOOK);
  revalidatePath(`${BOOK}/${leadId}`);
  return {
    success: "Recorded. Eva will not contact them again on any channel.",
  };
}
