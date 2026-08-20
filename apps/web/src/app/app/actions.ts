"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { canStartProduct } from "@/lib/product-hub";
import { createClient } from "@/lib/supabase/server";

export interface CreateOrganisationState {
  error?: string;
}

export interface StartProductState {
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

/**
 * Switch a product on from the hub, and go straight into it.
 *
 * ⚠️ THE LANDING IS THE POINT, NOT A CONVENIENCE. Founder, 2026-08-20: *"once
 * they choose, let's say invoice chasing, they land at invoice chasing
 * dashboard"*. Switching a product on and then returning somebody to the list
 * they just chose from makes them hunt for the thing they have already picked.
 * The settings screen deliberately does the opposite and stays put: somebody
 * MANAGING products is not somebody STARTING one.
 *
 * ⚠️ IT REFUSES ANYTHING WE HAVE NOT BUILT, and the check is here rather than
 * only on the screen. The hub renders a button for live products only — but a
 * form post is not a button. Without this, a hand-made post would switch on a
 * product with no screens behind it and then redirect the customer into a bare
 * 404: the exact defect PR #90 closed, re-created by the fix for a different
 * one.
 */
export async function startProduct(
  _prevState: StartProductState,
  formData: FormData,
): Promise<StartProductState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const moduleKey = String(formData.get("moduleKey") ?? "");

  if (!organisationId || !canStartProduct(moduleKey)) {
    return { error: "That product isn't available to switch on yet." };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/modules/${moduleKey}`, accessToken, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    // The API's own message names what is actually missing — a prerequisite, a
    // permission, a seat. Ours would be a guess (defect F4, slice 1.6).
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }

  /**
   * ⚠️ BOTH CALLS SIT OUTSIDE THE `try`, for the reason `submitOrganisation`
   * already documents: `redirect` works by throwing, so a redirect inside that
   * block would be caught by our own `catch` and reported to the customer as
   * "Something went wrong" — after their product had switched on perfectly.
   */
  revalidatePath("/app");
  redirect(moduleHref(moduleKey));
}
