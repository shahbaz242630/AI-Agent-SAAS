"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { readOpeningHoursForm } from "@/lib/opening-hours";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Saving the organisation's clock (slice 3.5a): its timezone and opening
 * hours, in one PATCH.
 *
 * ⚠️ A "use server" FILE MAY ONLY EXPORT ASYNC FUNCTIONS. Types are exported as
 * types (erased at build); the pure parts live in `lib/opening-hours.ts`.
 */

/** The out-of-hours card reads whether hours exist; it must not show stale. */
const AUTOMATIONS = moduleHref("lead_follow_up", "automations");

export interface OpeningHoursActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function saveOpeningHours(
  _prevState: OpeningHoursActionState,
  formData: FormData,
): Promise<OpeningHoursActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const timezone = String(formData.get("timezone") ?? "").trim();
  const intent = String(formData.get("intent") ?? "save");
  if (!timezone) return { error: "Pick the timezone your business keeps." };

  let businessHours: ReturnType<typeof readOpeningHoursForm> extends infer R
    ? R extends { hours: infer H }
      ? H | null
      : never
    : never;
  if (intent === "clear") {
    businessHours = null;
  } else {
    const read = readOpeningHoursForm((name) => {
      const value = formData.get(name);
      return value === null ? null : String(value);
    });
    if ("error" in read) return { error: read.error };
    businessHours = read.hours;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/settings`, accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone, businessHours }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "change-clock") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  revalidatePath("/app/settings/opening-hours");
  revalidatePath(AUTOMATIONS);
  // The home screen greets by the organisation's clock, and every date on
  // every screen is in it.
  revalidatePath("/app", "layout");

  return {
    success:
      businessHours === null
        ? `Opening hours removed. Eva keeps ${timezone} time, and the out-of-hours reply does nothing until you set them again.`
        : `Saved. Eva keeps ${timezone} time and knows when you are closed.`,
  };
}
