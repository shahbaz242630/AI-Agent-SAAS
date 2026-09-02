"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Recording a request never to be contacted again (Slice 3.1a).
 *
 * ⚠️ `logEnquiry` USED TO LIVE HERE AND WAS REMOVED ON 2026-08-21 with the
 * manual entry form it served. Founder ruling: Lead Follow-up is one
 * mailbox in and a reply out, so an enquiry either arrives in that mailbox or
 * it does not — there is nothing for a person to type in. The three sources
 * the form offered were all call-shaped and belong to a different product.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. The API writes the suppression list on
 * every channel it holds for the person. This layer moves a form to it and
 * turns what comes back into a sentence.
 */

/** Built from the catalogue, never written out — see `app-links.spec.ts`. */
const BOOK = moduleHref("lead_follow_up", "enquiries");

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
  /**
   * ⚠️ THE SECOND SENTENCE IS FOR THE PERSON WHO HAS JUST REALISED (2026-08-21).
   * Sales and reception press this button and CANNOT undo it — `leads:write`
   * records a do-not-contact, `suppression:manage` corrects one, and that split
   * is deliberate. So the moment somebody sees the consequence is the moment
   * they need to know a path exists and who to ask. Naming the screen without
   * linking it is on purpose: the link would take the two roles most likely to
   * click it straight into a refusal.
   */
  return {
    success:
      "Recorded. Eva will not contact them again on any channel. " +
      "If that was a mistake, an owner or administrator can correct it under Settings → Do not contact.",
  };
}
