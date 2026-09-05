"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isReplyChannel, moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Adding, rewriting and removing the wordings Eva replies with (slice 3.1c-1).
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING, the same rule the forwarding actions
 * follow. Which template is automatic, whether a name clashes, whether the
 * automatic one may be deleted — all of that is the API's, enforced against
 * the database. This layer moves a form to it and turns what comes back into a
 * sentence somebody can act on.
 */

/** Built from the catalogue, never written out — see `app-links.spec.ts`. */
const REPLIES = moduleHref("lead_follow_up", "replies");

export interface ReplyTemplateActionState {
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
 * ⚠️ 409 AND 400 KEEP THE API'S OWN WORDING, DELIBERATELY. Those are the
 * duplicate name, the ten-template cap and the refusal to delete the automatic
 * reply — each written for a customer, each naming the specific thing that is
 * in the way and what to do about it. Replacing them with a generic sentence
 * here would throw away the only part of the message that helps.
 */
function refusalFor(error: unknown): ReplyTemplateActionState {
  if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
  return {
    error:
      error instanceof ApiError
        ? (humanRefusal(error.status, "edit-reply-template") ?? error.message)
        : "Something went wrong. Please try again.",
  };
}

export async function saveReplyTemplate(
  _prevState: ReplyTemplateActionState,
  formData: FormData,
): Promise<ReplyTemplateActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  /**
   * ⚠️ CHECKED HERE TOO, FOR THE MESSAGE AND NOT FOR THE RULE. The schema, the
   * service and a CHECK constraint all refuse a blank one; what this adds is
   * that somebody who cleared the box gets told which box, rather than a 400
   * carrying a Zod path.
   */
  if (!name) return { error: "Give this reply a name so you can find it in the list." };
  if (!body) return { error: "A reply needs something to say." };

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/lead-reply-templates/${templateId}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, body }),
      },
    );
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(REPLIES);
  return { success: `Saved. Eva will use your wording of “${name}” from now on.` };
}

export async function addReplyTemplate(
  _prevState: ReplyTemplateActionState,
  formData: FormData,
): Promise<ReplyTemplateActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const channel = String(formData.get("channel") ?? "");

  if (!name) return { error: "Give this reply a name so you can find it in the list." };
  if (!body) return { error: "A reply needs something to say." };
  /**
   * ⚠️ REFUSED HERE RATHER THAN DEFAULTED (slice 3.2b). A missing channel means
   * the form and this action have drifted apart, and picking one for the
   * customer would file their wording against a medium they never chose — where
   * Eva may then send it. The API refuses it too; this is so the refusal is a
   * sentence rather than a 400 nobody sees.
   */
  if (!isReplyChannel(channel)) {
    return { error: "Something went wrong saving this reply. Refresh the page and try again." };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/lead-reply-templates`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      /**
       * ⚠️ `isAutomatic` IS NOT SENT, AND THAT IS THE SAFE DIRECTION. A new
       * wording is never silently promoted to the one Eva sends everybody;
       * making it automatic is a separate press with its own confirmation
       * sentence.
       */
      body: JSON.stringify({ channel, name, body }),
    });
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(REPLIES);
  return { success: `Added “${name}”. Eva keeps sending whichever wording is marked automatic.` };
}

/**
 * ⚠️ PROMOTE, TURN-OFF AND DELETE RETURN NO MESSAGE, AND THAT IS DELIBERATE
 * SINCE 2026-09-01. I wrote three careful sentences for them and **none of them
 * could ever reach a screen.**
 *
 * Each of those three actions changes what the card renders: promoting swaps
 * `MakeAutomatic` for `TurnOffAutomatic` (and reorders the list), turning off
 * swaps it back, and deleting removes the card outright. `revalidatePath`
 * refreshes the server data, the component that owns the action state
 * UNMOUNTS, and the message goes with it. Confirmed by walking the screen —
 * typecheck, lint and 2,003 tests are all perfectly happy with copy nobody can
 * ever read.
 *
 * The visible change IS the feedback, and it is better than a sentence: the
 * pill moves to the card at the top, the red "no automatic reply" banner
 * appears, the row disappears. `saveReplyTemplate` and `addReplyTemplate` keep
 * their messages because their components survive the change.
 *
 * ⚠️ SO DO NOT ADD A SUCCESS MESSAGE TO THE THREE BELOW WITHOUT MOVING THE
 * ACTION STATE SOMEWHERE THAT OUTLIVES THE CARD. It will look right in the
 * source and render nothing.
 */
/**
 * "Eva sends this one."
 *
 * ⚠️ ONE PRESS DOES BOTH HALVES, AND THE SCREEN HAS TO SAY SO BEFORE IT
 * HAPPENS. Promoting a template demotes whichever one held it — there is no
 * separate unset — so a customer who is not told would reasonably believe they
 * now have two automatic replies.
 *
 * That warning lives in the CONFIRMATION, which names both wordings ("reply
 * with X instead of Y?"), and not in a message afterwards: afterwards, this
 * component no longer exists. See the note above.
 */
export async function setAutomaticReply(
  _prevState: ReplyTemplateActionState,
  formData: FormData,
): Promise<ReplyTemplateActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/lead-reply-templates/${templateId}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAutomatic: true }),
      },
    );
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(REPLIES);
  // The pill moving to the top card is the confirmation — see the note above.
  return {};
}

/**
 * Turning the automatic reply off entirely.
 *
 * ⚠️ THIS IS THE ONE CONTROL THAT MAKES THE PRODUCT DO LESS, so what it
 * costs is said in the confirmation before it happens — enquiries still arrive
 * and are still filed, and nobody hears back until a person replies themselves
 * — and the red banner at the top of the screen keeps saying it afterwards,
 * for as long as it is true. A one-off "saved" would be true and useless.
 */
export async function turnOffAutomaticReply(
  _prevState: ReplyTemplateActionState,
  formData: FormData,
): Promise<ReplyTemplateActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/lead-reply-templates/${templateId}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAutomatic: false }),
      },
    );
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(REPLIES);
  // The red "no automatic reply is switched on" banner is the confirmation,
  // and it says more than this sentence could — it stays until it is fixed.
  return {};
}

export async function deleteReplyTemplate(
  _prevState: ReplyTemplateActionState,
  formData: FormData,
): Promise<ReplyTemplateActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/lead-reply-templates/${templateId}`,
      accessToken,
      { method: "DELETE" },
    );
  } catch (error) {
    return refusalFor(error);
  }

  revalidatePath(REPLIES);
  // The row disappearing is the confirmation — see the note above.
  return {};
}
