"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isLeadPlaybookKey, isReplyChannel, moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Switching a card on or off, and writing the words in its boxes (slice 3.5a).
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING, the same rule the forwarding actions
 * follow. Whether the out-of-hours card may be switched on, whether a box may
 * be emptied, who may press what — all of that is the API's, enforced against
 * the database. This layer moves a form to it and turns what comes back into a
 * sentence somebody can act on.
 */

/** Built from the catalogue, never written out — see `app-links.spec.ts`. */
const AUTOMATIONS = moduleHref("lead_follow_up", "automations");

export interface AutomationActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Turns a failed call into a sentence.
 *
 * ⚠️ 409 AND 400 KEEP THE API'S OWN WORDING, DELIBERATELY. The one 409 here is
 * "set your opening hours first", written for a customer and naming where to
 * go; replacing it with a generic sentence would throw away the only part of
 * the message that helps.
 */
function refusalFor(error: unknown): AutomationActionState {
  if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
  return {
    error:
      error instanceof ApiError
        ? (humanRefusal(error.status, "edit-reply-template") ?? error.message)
        : "Something went wrong. Please try again.",
  };
}

/** The card and the channel, refused rather than guessed when the form has drifted. */
function drifted(): AutomationActionState {
  return { error: "Something went wrong saving this. Refresh the page and try again." };
}

/**
 * The switch.
 *
 * ⚠️ RETURNS NO SUCCESS MESSAGE, AND THAT IS DELIBERATE. The control that
 * holds this action's state is rendered for the state the card is IN — "Switch
 * off" while on, "Switch on" while off — so a press changes which control
 * exists, `revalidatePath` refreshes the card, and the component holding the
 * message unmounts. The pill turning from Off to On IS the feedback (the
 * 2026-09-01 lesson from the Replies screen: four sentences nothing could
 * show).
 */
export async function setPlaybookEnabled(
  _prevState: AutomationActionState,
  formData: FormData,
): Promise<AutomationActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const key = String(formData.get("key") ?? "");
  const enabledField = String(formData.get("enabled") ?? "");
  if (!isLeadPlaybookKey(key) || (enabledField !== "true" && enabledField !== "false")) {
    return drifted();
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/lead-playbooks/${key}`, accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enabledField === "true" }),
    });
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(AUTOMATIONS);
  return {};
}

export async function savePlaybookWording(
  _prevState: AutomationActionState,
  formData: FormData,
): Promise<AutomationActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const key = String(formData.get("key") ?? "");
  const channel = String(formData.get("channel") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!isLeadPlaybookKey(key) || !isReplyChannel(channel)) return drifted();

  /**
   * ⚠️ AN EMPTY SAVE IS REFUSED WITH THE WAY OUT. The schema and a CHECK both
   * refuse a blank wording; what this adds is that somebody who cleared the
   * box and pressed Save is told that silence is a different button.
   */
  if (!body) {
    return {
      error:
        "A wording needs something to say. To leave Eva silent on this channel, clear the box instead.",
    };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/lead-playbooks/${key}/wordings/${channel}`,
      accessToken,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(AUTOMATIONS);
  return { success: "Saved. Eva will use these words from now on." };
}

/**
 * Emptying a box. Returns no message: the clear control is rendered only
 * while the box holds words, so after the refresh it no longer exists — the
 * box being empty, with its own line saying what that means, is the feedback.
 */
export async function clearPlaybookWording(
  _prevState: AutomationActionState,
  formData: FormData,
): Promise<AutomationActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const key = String(formData.get("key") ?? "");
  const channel = String(formData.get("channel") ?? "");
  if (!isLeadPlaybookKey(key) || !isReplyChannel(channel)) return drifted();

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/lead-playbooks/${key}/wordings/${channel}`,
      accessToken,
      { method: "DELETE" },
    );
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(AUTOMATIONS);
  return {};
}
