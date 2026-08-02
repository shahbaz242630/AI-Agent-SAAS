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

/**
 * Which screen a connection was started from. The API carries this on the
 * signed OAuth state and maps it back to a path from its own fixed table, so
 * the round trip through Microsoft returns the user where they began.
 *
 * A closed set, and re-checked here rather than forwarded as typed: a server
 * action is reachable by direct POST, so a form field is untrusted input even
 * though our own UI is the only thing that renders the form.
 */
const CONNECT_FLOWS = ["onboarding", "settings"] as const;
type ConnectFlow = (typeof CONNECT_FLOWS)[number];

const FLOW_PATHS: Record<ConnectFlow, string> = {
  onboarding: "/app/onboarding",
  settings: MAILBOX_PATH,
};

function readFlow(formData: FormData): ConnectFlow {
  const value = String(formData.get("flow") ?? "");
  return CONNECT_FLOWS.includes(value as ConnectFlow) ? (value as ConnectFlow) : "settings";
}

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
  flow: ConnectFlow,
  replacesMailboxId: string | null = null,
): Promise<string> {
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailboxes/connect`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(emailAddress ? { emailAddress } : {}),
          flow,
          ...(replacesMailboxId ? { replacesMailboxId } : {}),
        }),
      },
    );
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    return authorizeUrl;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return "/sign-in";
    // A malformed address is a 400 with the API's own message, which now
    // survives apiFetch (F4) — but this action can only redirect, so it goes
    // back as a code the page already knows how to render. Back to the screen
    // they started from, not always to settings.
    return `${FLOW_PATHS[flow]}?error=${error instanceof ApiError && error.status === 400 ? "invalid_address" : "connect_failed"}`;
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
  redirect(
    await resolveConnectTarget(
      organisationId,
      accessToken,
      emailAddress,
      readFlow(formData),
      // Present only on the Replace form (slice 1.6b, ruling 3). Empty means an
      // ordinary connect, which is the overwhelmingly common case.
      String(formData.get("replacesMailboxId") ?? "").trim() || null,
    ),
  );
}

const MODULES_PATH = "/app/settings/modules";

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

export async function disconnectMailbox(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const mailboxId = String(formData.get("mailboxId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  let result: {
    clientsMoved: number;
    unfiledClientsMoved: number;
    movedToEmailAddress: string | null;
  };
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailboxes/${mailboxId}/disconnect`,
      accessToken,
      { method: "POST" },
    );
    result = (await response.json()) as typeof result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }
  revalidatePath(MAILBOX_PATH);
  revalidatePath("/app/clients");
  /**
   * RULING 3: never silent — and it has to SURVIVE.
   *
   * This message used to be returned as action state held by the mailbox card's
   * own controls. Disconnecting removes that card from the re-rendered list, so
   * the component holding the sentence unmounted as the sentence arrived: the
   * one guarantee ruling 3 makes had no surviving place to be read. It now goes
   * back as a redirect flash, the same mechanism the connect flow already uses,
   * which outlives the row it describes.
   */
  redirect(`${MAILBOX_PATH}?${new URLSearchParams(disconnectFlash(result)).toString()}`);
}

/**
 * What a disconnect actually cost, as query parameters the settings page
 * renders.
 *
 * BOTH numbers matter and they are different groups. `clientsMoved` is the
 * clients filed under the mailbox that just went. `unfiledClientsMoved` is
 * everyone who was never filed at all — they change address too when the
 * DEFAULT is disconnected, and by ruling 1 they are usually the majority.
 * Reporting only the first said "Mailbox disconnected." while several hundred
 * people quietly started being chased from somewhere else.
 */
function disconnectFlash(result: {
  clientsMoved: number;
  unfiledClientsMoved: number;
  movedToEmailAddress: string | null;
}): Record<string, string> {
  return {
    disconnected: "1",
    moved: String(result.clientsMoved),
    unfiled: String(result.unfiledClientsMoved),
    ...(result.movedToEmailAddress ? { to: result.movedToEmailAddress } : {}),
  };
}

/** Which mailbox Eva sends reminders from. */
export async function setPrimaryMailbox(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const mailboxId = String(formData.get("mailboxId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  try {
    await apiFetch(`/organisations/${organisationId}/mailboxes/${mailboxId}/primary`, accessToken, {
      method: "PUT",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }
  revalidatePath(MAILBOX_PATH);
  return { success: "Eva will send reminders from that mailbox." };
}

export async function sendTestEmail(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const mailboxId = String(formData.get("mailboxId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  let to = "";
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailboxes/${mailboxId}/test-email`,
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
