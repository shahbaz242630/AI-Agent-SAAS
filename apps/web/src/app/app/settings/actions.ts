"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

/**
 * Mailbox settings actions (Slice 1.6, ruling 1 — thin UI). The browser never
 * talks to the API directly; tokens and OAuth codes never touch this app —
 * `connectMailbox` only ferries the Microsoft authorize URL. Authorisation is
 * the API's job (mailbox:read / mailbox:manage, 403/404), which matters because
 * server actions are reachable by direct POST, not just through our own UI.
 */

const MAILBOX_PATH = "/app/settings/mailbox";

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
 * Resolves where the browser should go next. Split out so the single
 * `redirect()` call sits OUTSIDE any try block — `redirect` works by throwing,
 * so a redirect inside the try would be swallowed by our own catch (Next.js 16
 * redirect docs, "Behavior").
 */
async function resolveConnectTarget(organisationId: string, accessToken: string): Promise<string> {
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailbox/connect`,
      accessToken,
      {
        method: "POST",
      },
    );
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    return authorizeUrl;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return "/sign-in";
    return `${MAILBOX_PATH}?error=connect_failed`;
  }
}

/** Connect: fetch the Microsoft authorize URL, then send the browser there. */
export async function connectMailbox(formData: FormData): Promise<void> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  redirect(await resolveConnectTarget(organisationId, accessToken));
}

export async function disconnectMailbox(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  try {
    await apiFetch(`/organisations/${organisationId}/mailbox/disconnect`, accessToken, {
      method: "POST",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }
  revalidatePath(MAILBOX_PATH);
  return { success: "Mailbox disconnected. Reminders can't be sent until you reconnect." };
}

export async function sendTestEmail(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  let to = "";
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailbox/test-email`,
      accessToken,
      { method: "POST" },
    );
    ({ to } = (await response.json()) as { to: string });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    // A dead grant returns 400; the status card carries the actionable detail
    // (lastError) once revalidated, so the generic message is enough here.
    revalidatePath(MAILBOX_PATH);
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }
  revalidatePath(MAILBOX_PATH);
  return { success: `Test email sent to ${to}. Check the inbox and Sent Items.` };
}
