"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { correctionReasonRefusal } from "@/lib/do-not-contact";
import { createClient } from "@/lib/supabase/server";

/**
 * Recording that a do-not-contact entry was made in error (2026-08-21).
 *
 * ⚠️ THIS IS NOT AN UNDO BUTTON AND THE WORDING NEVER CALLS IT ONE. The API
 * appends a correction; the original entry stays in the log forever, and a
 * person who genuinely asked not to be contacted must stay unreachable. This
 * exists for the mis-click — the founder came one click away from permanently
 * silencing a real client's billing address on 2026-08-20.
 */

const PATH = "/app/settings/do-not-contact";

export interface CorrectionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function correctSuppression(
  _prevState: CorrectionState,
  formData: FormData,
): Promise<CorrectionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const channel = String(formData.get("channel") ?? "");
  const value = String(formData.get("value") ?? "");
  const reason = String(formData.get("reason") ?? "");

  /**
   * Checked here as well as at the API and in the database, because the
   * alternative is a round trip to be told the obvious. The API's refusal is
   * still the one that counts.
   */
  const refusal = correctionReasonRefusal(reason);
  if (refusal) return { error: refusal };

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/suppression/corrections`, accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, value, reason: reason.trim() }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    /**
     * ⚠️ A 404 HERE IS NOT "NOT FOUND", IT IS "SOMEBODY ELSE GOT THERE FIRST".
     * The API refuses when the value is no longer suppressed — already
     * corrected, by another administrator or by a double-submitted form — and
     * "That is not currently a do-not-contact entry" would read as a fault.
     */
    if (error instanceof ApiError && error.status === 404) {
      return {
        error: "That entry is no longer on the list — somebody may have just corrected it.",
      };
    }
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "correct-suppression") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  revalidatePath(PATH);
  return { success: "Recorded as an error. Eva can contact them again." };
}
