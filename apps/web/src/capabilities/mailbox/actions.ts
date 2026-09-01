"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isModuleKey, moduleHref, type ModuleKey } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

/**
 * Mailbox actions (Slice 1.6, ruling 1 — thin UI). The browser never talks to
 * the API directly; tokens and OAuth codes never touch this app —
 * `connectMailbox` only ferries the authorize URL. Authorisation is the API's
 * job (mailbox:read / mailbox:manage, 403/404), which matters because server
 * actions are reachable by direct POST, not just through our own UI.
 *
 * ⚠️ MOVED HERE FROM `app/settings/actions.ts` IN SLICE 3.1c-0, WITH THE SCREEN.
 * Mailbox setup now lives inside each product (founder ruling 2026-09-01), so
 * these no longer belong to the settings area at all — and leaving them there
 * would have meant a product screen importing its writes out of `settings/`,
 * which is how the next person concludes mailboxes are still organisation-wide.
 *
 * ⚠️ EVERY ACTION HERE NOW CARRIES A PRODUCT. Disconnect and Make default both
 * reach across a whole product's mailboxes — promoting a successor, demoting
 * the old default — so running one against the wrong product would move a
 * mailbox the customer never touched.
 */

/** Where this product's mailbox screen lives. One rule, never a literal path:
 *  the segment comes from the catalogue, so a rename cannot strand a redirect. */
function mailboxPath(moduleKey: ModuleKey): string {
  return moduleHref(moduleKey, "mailbox");
}

/**
 * Which product a form is acting on.
 *
 * ⚠️ RE-CHECKED HERE RATHER THAN TRUSTED, like `flow` and `provider` below: a
 * server action is reachable by direct POST, so a form field is untrusted input
 * even though our own UI renders the only form.
 *
 * ⚠️ AND IT RETURNS NULL RATHER THAN FALLING BACK. `provider` degrades to
 * Microsoft and `flow` to settings, because a garbled field should not cost
 * somebody their connection and both fallbacks are harmless. There is no
 * harmless guess here — picking a product would file the mailbox against one
 * the customer never chose, bill its seat, and look entirely successful.
 */
function readModuleKey(formData: FormData): ModuleKey | null {
  const value = String(formData.get("moduleKey") ?? "");
  return isModuleKey(value) ? value : null;
}

/**
 * Which screen a connection was started from. The API carries this on the
 * signed OAuth state and maps it back to a path from its own fixed table, so
 * the round trip through the provider returns the user where they began.
 *
 * A closed set, and re-checked here rather than forwarded as typed.
 *
 * ⚠️ `onboarding` IS LEGACY AS OF SLICE 3.1c-0 AND NOTHING MINTS IT ANY MORE.
 * Onboarding stopped connecting mailboxes (founder ruling 2026-09-01) — you
 * connect one inside the product that will use it. The value stays in the set
 * so a connection already in flight across that deploy still lands somewhere
 * real rather than being refused.
 */
const CONNECT_FLOWS = ["onboarding", "settings"] as const;
type ConnectFlow = (typeof CONNECT_FLOWS)[number];

function readFlow(formData: FormData): ConnectFlow {
  const value = String(formData.get("flow") ?? "");
  return CONNECT_FLOWS.includes(value as ConnectFlow) ? (value as ConnectFlow) : "settings";
}

/**
 * Which mailbox provider the customer picked (Slice 3.1b step 3).
 *
 * Anything unrecognised falls back to Microsoft — the provider that has always
 * worked — rather than erroring, because a garbled field should not cost
 * somebody their connection.
 */
const CONNECT_PROVIDERS = ["microsoft", "google"] as const;
type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];

function readProvider(formData: FormData): ConnectProvider {
  const value = String(formData.get("provider") ?? "");
  return CONNECT_PROVIDERS.includes(value as ConnectProvider)
    ? (value as ConnectProvider)
    : "microsoft";
}

export interface MailboxActionState {
  error?: string;
  success?: string;
}

/** What every action says when the product field is missing or unreadable. It
 *  cannot be reached through our own UI, so it names the fault rather than
 *  pretending the customer did something wrong. */
const NO_PRODUCT: MailboxActionState = {
  error: "That form was missing which product it applies to. Reload the page and try again.",
};

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
  moduleKey: ModuleKey,
  accessToken: string,
  emailAddress: string,
  flow: ConnectFlow,
  provider: ConnectProvider,
  replacesMailboxId: string | null = null,
): Promise<string> {
  const back = flow === "onboarding" ? "/app/onboarding" : mailboxPath(moduleKey);
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/mailboxes/connect`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(emailAddress ? { emailAddress } : {}),
          // Required by the API, never defaulted — see the note on `moduleKey`
          // in packages/validation.
          moduleKey,
          provider,
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
    // back as a code the page already knows how to render.
    return `${back}?error=${error instanceof ApiError && error.status === 400 ? "invalid_address" : "connect_failed"}`;
  }
}

/**
 * Connect: fetch the authorize URL, then send the browser there.
 *
 * The address is optional and is only ever a hint — it becomes the provider's
 * `login_hint` so someone signed into two accounts lands on the right one
 * (defect F5), and its domain tells us whether an administrator can even exist
 * if consent is declined (F1). Eva never asks for the password; that happens at
 * the provider, and asking here would train people into exactly the behaviour
 * phishing relies on.
 */
export async function connectMailbox(formData: FormData): Promise<void> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const emailAddress = String(formData.get("emailAddress") ?? "").trim();
  const moduleKey = readModuleKey(formData);
  // This action can only redirect, so an unreadable product goes to the hub
  // rather than guessing one. Unreachable through our own UI.
  if (!moduleKey) redirect("/app");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  redirect(
    await resolveConnectTarget(
      organisationId,
      moduleKey,
      accessToken,
      emailAddress,
      readFlow(formData),
      readProvider(formData),
      // Present only on the Replace form (slice 1.6b, ruling 3). Empty means an
      // ordinary connect, which is the overwhelmingly common case.
      String(formData.get("replacesMailboxId") ?? "").trim() || null,
    ),
  );
}

export async function disconnectMailbox(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const mailboxId = String(formData.get("mailboxId") ?? "");
  const moduleKey = readModuleKey(formData);
  if (!moduleKey) return NO_PRODUCT;
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
  revalidatePath(mailboxPath(moduleKey));
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
  redirect(`${mailboxPath(moduleKey)}?${new URLSearchParams(disconnectFlash(result)).toString()}`);
}

/**
 * What a disconnect actually cost, as query parameters the mailbox screen
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

/** Which mailbox this product sends from. */
export async function setPrimaryMailbox(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const mailboxId = String(formData.get("mailboxId") ?? "");
  const moduleKey = readModuleKey(formData);
  if (!moduleKey) return NO_PRODUCT;
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
  revalidatePath(mailboxPath(moduleKey));
  return { success: "Eva will send from that mailbox." };
}

export async function sendTestEmail(
  _prevState: MailboxActionState,
  formData: FormData,
): Promise<MailboxActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const mailboxId = String(formData.get("mailboxId") ?? "");
  const moduleKey = readModuleKey(formData);
  if (!moduleKey) return NO_PRODUCT;
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
    revalidatePath(mailboxPath(moduleKey));
    return {
      error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
    };
  }
  revalidatePath(mailboxPath(moduleKey));
  return { success: `Test email sent to ${to}. Check the inbox and Sent Items.` };
}
