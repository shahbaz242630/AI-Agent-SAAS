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

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}

export async function createOrganisation(
  _prevState: CreateOrganisationState,
  formData: FormData,
): Promise<CreateOrganisationState> {
  const name = String(formData.get("name") ?? "").trim();
  if (name.length === 0) {
    return { error: "Please enter an organisation name." };
  }
  if (name.length > 200) {
    return { error: "Organisation names must be 200 characters or fewer." };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    redirect("/sign-in");
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
      redirect("/sign-in");
    }
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }

  redirect("/app");
}
