"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

/**
 * Client actions (slice 1.6b, Task 8). The browser never talks to the API
 * directly — authorisation is the API's job, which matters because a server
 * action is reachable by direct POST and not only through our own forms.
 *
 * "Client" in the interface is `customer` in the API and the database. The
 * founder's customers call the people who owe them money clients, and the
 * screens follow them rather than the schema.
 */

const CLIENTS_PATH = "/app/clients";

export interface ClientActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Trims, and turns "" into undefined so an empty optional field is omitted
 *  rather than sent as a blank string the API would have to reject. */
function optional(formData: FormData, key: string): string | undefined {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function failed(error: unknown): ClientActionState {
  // The API's own message names what was wrong with the input, and it survives
  // apiFetch now (defect F4). Anything else is ours and stays generic.
  return {
    error: error instanceof ApiError ? error.message : "Something went wrong. Please try again.",
  };
}

/**
 * Add a client.
 *
 * `emailAccountId` is optional and carries the mailbox the user was looking at
 * when they added it — this is the founder's model: you connect trade@, you add
 * trade's clients while you are inside trade's screen, and they belong to it
 * without anybody ticking a box. Absent means unallocated, which is chased from
 * the default (ruling 1) and is a perfectly normal state.
 */
export async function addClient(
  _prevState: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const emailAccountId = optional(formData, "emailAccountId");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  let customerId: string;
  try {
    const response = await apiFetch(`/organisations/${organisationId}/customers`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: String(formData.get("name") ?? "").trim(),
        ...(optional(formData, "email") ? { email: optional(formData, "email") } : {}),
        ...(optional(formData, "phone") ? { phone: optional(formData, "phone") } : {}),
        ...(optional(formData, "reference") ? { reference: optional(formData, "reference") } : {}),
      }),
    });
    ({ id: customerId } = (await response.json()) as { id: string });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error);
  }

  /**
   * The allocation is a SECOND call, deliberately.
   *
   * `POST /customers` is a core endpoint that must keep working for an
   * organisation with no mailbox at all, so it does not take a mailbox. Filing
   * afterwards keeps that true and reuses the audited allocation path rather
   * than growing a second way to write the same column.
   *
   * If this half fails the client still exists and is chased from the default
   * (ruling 1) — nobody is lost, and the message says what happened rather than
   * pretending the whole thing failed.
   */
  if (emailAccountId) {
    try {
      await apiFetch(`/organisations/${organisationId}/customers/allocation`, accessToken, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerIds: [customerId], emailAccountId }),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      revalidatePath(CLIENTS_PATH);
      return {
        error: `Client added, but it couldn't be filed under that mailbox — it will be chased from your default mailbox. ${
          error instanceof ApiError ? error.message : "Please try assigning it again."
        }`,
      };
    }
  }

  revalidatePath(CLIENTS_PATH);
  // The mailbox settings card shows a client count, and that count is the copy
  // that states the cost of a Disconnect or a Replace BEFORE the click. Leaving
  // it stale understates what the user is about to lose.
  revalidatePath(moduleHref("email_credit_controller", "mailbox"));
  return { success: "Client added." };
}

export async function updateClient(
  _prevState: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  try {
    await apiFetch(`/organisations/${organisationId}/customers/${customerId}`, accessToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: String(formData.get("name") ?? "").trim(),
        ...(optional(formData, "email") ? { email: optional(formData, "email") } : {}),
        ...(optional(formData, "phone") ? { phone: optional(formData, "phone") } : {}),
        ...(optional(formData, "reference") ? { reference: optional(formData, "reference") } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error);
  }
  revalidatePath(CLIENTS_PATH);
  return { success: "Client updated." };
}

export async function removeClient(
  _prevState: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  try {
    await apiFetch(`/organisations/${organisationId}/customers/${customerId}`, accessToken, {
      method: "DELETE",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error);
  }
  revalidatePath(CLIENTS_PATH);
  return { success: "Client removed." };
}

/**
 * File a set of clients under one mailbox — or under none.
 *
 * The ids arrive as repeated `customerIds` fields from the checkboxes. An empty
 * selection is refused here rather than sent: the API bounds the batch at both
 * ends, and a request naming nothing is a mis-click, not an instruction.
 *
 * `emailAccountId` of "" means "back to the default", which is an explicit,
 * legal action under ruling 1 — not a missing value.
 */
export async function assignClients(
  _prevState: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const customerIds = formData.getAll("customerIds").map(String).filter(Boolean);
  const raw = String(formData.get("emailAccountId") ?? "");
  const emailAccountId = raw.length > 0 ? raw : null;
  if (customerIds.length === 0) return { error: "Choose at least one client first." };

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");
  let moved: number;
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/customers/allocation`,
      accessToken,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerIds, emailAccountId }),
      },
    );
    ({ moved } = (await response.json()) as { moved: number });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return failed(error);
  }
  revalidatePath(CLIENTS_PATH);
  revalidatePath(moduleHref("email_credit_controller", "mailbox"));
  // "0 moved" is a real answer, not a failure: they were already there. Saying
  // "moved 0 clients" would read as a bug, so it gets its own sentence.
  if (moved === 0) return { success: "Those clients were already filed there." };
  return {
    success: `${moved === 1 ? "1 client" : `${moved} clients`} ${
      emailAccountId ? "filed under that mailbox." : "moved back to your default mailbox."
    }`,
  };
}
