"use server";

import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

export interface CreateOrganisationState {
  error?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * ⚠️ IT LANDS ON `/signed-out`, NOT `/sign-in` (2026-08-10). Dropping somebody
 * on a sign-in form immediately after they chose to leave reads as "that
 * didn't work" — it is the identical screen a failed session produces. The
 * confirmation page says the one thing that matters at that moment: reminders
 * already scheduled still go out.
 */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/signed-out");
}

/**
 * Creates the organisation and reports what happened, without redirecting.
 *
 * The destination is left to the caller so it is decided by WHICH action a form
 * calls — a literal in our own code — rather than by a field the browser
 * supplies. It also keeps every `redirect()` at the top level of an action:
 * redirect works by throwing, so one called inside this function's try would be
 * swallowed by its own catch (Next.js 16 redirect docs, "Behavior").
 */
async function submitOrganisation(
  formData: FormData,
): Promise<{ error?: string; signedOut?: boolean }> {
  const name = String(formData.get("name") ?? "").trim();
  if (name.length === 0) {
    return { error: "Please enter an organisation name." };
  }
  if (name.length > 200) {
    return { error: "Organisation names must be 200 characters or fewer." };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { signedOut: true };
  }

  try {
    // The API assigns the org id and owner role server-side (BRD 15) — the
    // browser never talks to the API directly.
    await apiFetch("/organisations", accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { signedOut: true };
    }
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }

  return {};
}

export async function createOrganisation(
  _prevState: CreateOrganisationState,
  formData: FormData,
): Promise<CreateOrganisationState> {
  const result = await submitOrganisation(formData);
  if (result.signedOut) redirect("/sign-in");
  if (result.error) return { error: result.error };
  redirect("/app");
}

/** Same creation, but keeps a new customer inside the setup journey instead of
 *  dropping them on an organisation list they have no use for yet. */
export async function createOrganisationForOnboarding(
  _prevState: CreateOrganisationState,
  formData: FormData,
): Promise<CreateOrganisationState> {
  const result = await submitOrganisation(formData);
  if (result.signedOut) redirect("/sign-in");
  if (result.error) return { error: result.error };
  redirect("/app/onboarding");
}
