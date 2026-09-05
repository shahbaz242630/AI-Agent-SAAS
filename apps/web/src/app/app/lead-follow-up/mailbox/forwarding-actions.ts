"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

/**
 * Setting forwarding up, and answering requests we did not expect (3.1b step 4).
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. Whether Eva answers Google for the customer
 * is decided by the API, from the armed window on their own address row. This
 * layer moves a form to it and turns what comes back into a sentence — the same
 * rule the enquiry actions follow.
 *
 * Moved from the Forwarding page to the Mailbox tab on 2026-09-05, when the
 * receiving half of email set-up joined the sending half on one screen.
 */

/** Built from the catalogue, never written out — see `app-links.spec.ts`. */
const MAILBOX = moduleHref("lead_follow_up", "mailbox");

export interface ForwardingActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * "I am setting this up now."
 *
 * ⚠️ THIS IS THE SECURITY DECISION ON THIS SCREEN, WEARING A FRIENDLY BUTTON.
 * For the next half hour Eva will answer Google's confirmation for this
 * organisation without asking. That is what makes the setup three clicks
 * instead of a code hunt — and it is why the window is short, and why the
 * button says what it does rather than "Continue".
 */
export async function startForwardingSetup(
  _prevState: ForwardingActionState,
  formData: FormData,
): Promise<ForwardingActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/forwarding/arm`, accessToken, {
      method: "POST",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "forwarding-setup") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  revalidatePath(MAILBOX);
  return { success: "Ready — now follow the steps below. Eva is watching for Google's email." };
}

/**
 * "Yes, that was me" or "no, it wasn't".
 *
 * ⚠️ THE TWO ANSWERS ARE NOT SYMMETRICAL AND THE COPY MUST NOT PRETEND THEY
 * ARE. Confirming starts a stranger's mail flowing into this customer's book.
 * Declining only means Eva will not confirm it — Google never starts
 * forwarding without that confirmation, so nothing further needs doing, and we
 * must not claim to have cancelled anything at Google's end because we have
 * not.
 */
export async function answerForwardingRequest(
  _prevState: ForwardingActionState,
  formData: FormData,
): Promise<ForwardingActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const requestId = String(formData.get("requestId") ?? "");
  const decision = String(formData.get("decision") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  let status = "";
  let failureReason: string | null = null;
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/forwarding/requests/${requestId}`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    );
    const body = (await response.json()) as { status: string; failureReason: string | null };
    status = body.status;
    failureReason = body.failureReason;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "forwarding-request") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  revalidatePath(MAILBOX);

  if (status === "declined") {
    return {
      success:
        "Turned down. Eva won't confirm it, and without that confirmation Google never starts forwarding.",
    };
  }
  if (status === "confirmed") {
    return { success: "Confirmed. Mail forwarded from that address will arrive as enquiries." };
  }
  /**
   * ⚠️ STILL PENDING IS NOT SUCCESS, AND SAYING "DONE" HERE WOULD BE THE WHOLE
   * DEFECT OF THIS SLICE IN ONE SENTENCE. Google answers our confirmation with
   * a page that says "please confirm"; treating that as agreement is exactly
   * what shipped broken once already. If the request is still open, the screen
   * says so and offers the link.
   */
  return {
    error: failureReason
      ? `Eva couldn't confirm it with Google — ${failureReason}. You can finish it yourself with the link below.`
      : "Eva couldn't confirm it with Google. You can finish it yourself with the link below.",
  };
}
