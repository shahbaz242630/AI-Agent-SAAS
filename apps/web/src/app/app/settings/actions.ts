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
async function resolveConnectTarget(
  organisationId: string,
  accessToken: string,
  emailAddress: string,
): Promise<string> {
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailbox/connect`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(emailAddress ? { emailAddress } : {}),
      },
    );
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    return authorizeUrl;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return "/sign-in";
    // A malformed address is a 400 with the API's own message, which now
    // survives apiFetch (F4) — but this action can only redirect, so it goes
    // back as a code the page already knows how to render.
    return `${MAILBOX_PATH}?error=${error instanceof ApiError && error.status === 400 ? "invalid_address" : "connect_failed"}`;
  }
}

/**
 * Connect: fetch the Microsoft authorize URL, then send the browser there.
 *
 * The address is optional and is only ever a hint — it becomes Microsoft's
 * `login_hint` so someone signed into two accounts lands on the right one
 * (defect F5), and its domain tells us whether an administrator can even exist
 * if consent is declined (F1). Eva never asks for the password; that happens at
 * Microsoft, and asking here would train people into exactly the behaviour
 * phishing relies on.
 */
export async function connectMailbox(formData: FormData): Promise<void> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const emailAddress = String(formData.get("emailAddress") ?? "").trim();
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  redirect(await resolveConnectTarget(organisationId, accessToken, emailAddress));
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
