"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

/**
 * Settings actions (Slice 1.6, ruling 1 — thin UI). The browser never talks to
 * the API directly. Authorisation is the API's job (403/404), which matters
 * because server actions are reachable by direct POST, not just through our own
 * UI.
 *
 * ⚠️ THE MAILBOX ACTIONS LEFT THIS FILE IN SLICE 3.1c-0 and now live in
 * `@/capabilities/mailbox/actions`, with the screen they serve. Mailbox setup
 * belongs inside each product (founder ruling 2026-09-01), so a product screen
 * importing its writes out of `settings/` would have quietly said the opposite
 * — that mailboxes are still one organisation-wide thing.
 */

const MODULES_PATH = "/app/settings/modules";

/**
 * The shape every settings action returns.
 *
 * ⚠️ STILL CALLED `MailboxActionState` AND THAT NAME IS NOW WRONG. It predates
 * the products screen, which reuses it because the shape is generic. Renaming
 * it touches every control that imports it and buys nothing today; it is
 * recorded here so the next person reads it as a legacy name rather than as
 * evidence that turning a product on has something to do with mailboxes.
 */
export interface MailboxActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Turn a product on or off, or change how many seats it has (slice 1.6a).
 *
 * `seats` is only sent when the form actually carries it, because omitting it
 * means "leave it alone" on the API side — an enable must never silently reset
 * a seat count somebody paid for.
 *
 * The form submits an `intent`, not a raw `enabled` flag. Both buttons live in
 * one form alongside the seats input, so "buy a seat" and "turn it on" arrive
 * looking identical; the intent is what separates them, and it decides both
 * the message shown here and the verb audited by the API.
 */
export async function setModule(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const moduleKey = String(formData.get("moduleKey") ?? "");
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "enable" && intent !== "disable" && intent !== "seats") {
    return { error: "Something went wrong. Please try again." };
  }
  const enabled = intent !== "disable";
  const rawSeats = String(formData.get("seats") ?? "").trim();
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  try {
    await apiFetch(`/organisations/${organisationId}/modules/${moduleKey}`, accessToken, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, ...(rawSeats ? { seats: Number(rawSeats) } : {}) }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    // The API's own message names the missing prerequisite, or how many
    // mailboxes must be disconnected first — both are things only it knows,
    // and both survive apiFetch now (F4).
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }
  revalidatePath(MODULES_PATH);
  if (intent === "seats") return { success: "Mailbox seats saved." };
  return { success: enabled ? "Product turned on." : "Product turned off." };
}
