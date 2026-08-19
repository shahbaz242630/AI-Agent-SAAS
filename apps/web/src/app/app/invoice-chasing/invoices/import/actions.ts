"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import { MAX_UPLOAD_BYTES } from "@/lib/import-messages";
import { createClient } from "@/lib/supabase/server";

/**
 * Uploading a book (slice 1.6c — the founder's upload → preview → confirm).
 *
 * ⚠️ THE ENGINE ALREADY EXISTED AND WAS SCREENLESS SINCE SLICE 1.3. Nothing
 * here parses, maps or validates anything: the API stages the file, maps the
 * headers, marks each row valid / duplicate / suppressed / invalid, and creates
 * DRAFT invoices only on confirm. This layer moves bytes and says what
 * happened.
 */

/**
 * ⚠️ A `"use server"` FILE MAY ONLY EXPORT ASYNC FUNCTIONS. `MAX_UPLOAD_BYTES`
 * used to live here and produced a runtime 500 on the first real upload — "can
 * only export async functions, found number" — after passing typecheck AND
 * lint. Constants and types belong in `lib/`; this file exports actions only.
 */
export interface ImportActionState {
  error?: string;
  success?: string;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Send the file, then go to its preview.
 *
 * ⚠️ THE FILE IS FORWARDED, NOT READ. It goes straight through as multipart, so
 * a spreadsheet is never parsed in the web layer — the API is the only thing
 * that decides what a row means, and it re-checks everything at confirm anyway.
 *
 * ⚠️ NO `Content-Type` HEADER. `fetch` must set it itself for multipart,
 * because only it knows the boundary; setting it by hand produces a body the
 * far end cannot split.
 */
export async function uploadImport(
  _prevState: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a CSV or Excel file to upload." };
  }
  /**
   * Checked here as well as at the API because the alternative is uploading
   * five megabytes to be told no. The API's limit is the one that counts.
   */
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      error: `That file is ${Math.round(file.size / (1024 * 1024))} MB. The limit is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  const body = new FormData();
  body.append("file", file, file.name);

  let importId: string;
  try {
    const response = await apiFetch(`/organisations/${organisationId}/imports`, accessToken, {
      method: "POST",
      body,
    });
    const detail = (await response.json()) as { id: string };
    importId = detail.id;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      // A 403 becomes a sentence; a 400 keeps the API's, which names the column
      // or the row that could not be read. See `lib/permissions.ts`.
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "upload-import") ?? error.message)
          : "We couldn't read that file. Please try again.",
    };
  }

  // Outside the try: `redirect` works by throwing, and catching it here would
  // turn a successful upload into "something went wrong".
  redirect(`/app/invoices/import/${importId}`);
}

/** Turn the staged rows into draft invoices. */
export async function confirmImport(
  _prevState: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const importId = String(formData.get("importId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/imports/${importId}/confirm`, accessToken, {
      method: "POST",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "confirm-import") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  // Both: the book now has new rows, and this page becomes the report.
  revalidatePath("/app/invoices");
  revalidatePath(`/app/invoices/import/${importId}`);
  return { success: "Imported." };
}

/**
 * Throw the staged rows away.
 *
 * The reason this exists rather than "edit the mapping": a wrong mapping is
 * best fixed by cancelling and uploading again (plan §3), and nothing has been
 * created yet, so nothing is lost.
 */
export async function cancelImport(
  _prevState: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const importId = String(formData.get("importId") ?? "");

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(`/organisations/${organisationId}/imports/${importId}/cancel`, accessToken, {
      method: "POST",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "cancel-import") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  redirect("/app/invoices/import");
}
