"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { humanRefusal } from "@/lib/permissions";
import {
  describeOffset,
  toOffsetDays,
  validateOffset,
  type OffsetDirection,
} from "@/products/invoice-follow-up/reminder-sequence";
import { createClient } from "@/lib/supabase/server";

/**
 * Reminder timing settings (Slice 1.8; founder ruling 2026-08-08).
 *
 * ⚠️ A "use server" FILE MAY ONLY EXPORT ASYNC FUNCTIONS — types are erased, so
 * they are fine; a plain exported constant is a runtime 500 that typecheck and
 * lint both pass. The constants this file needs live in `products/invoice-follow-up/reminder-sequence`.
 */

export interface ReminderStepActionState {
  error?: string;
  success?: string;
  /** Which step the message belongs to — six forms share one screen. */
  stepId?: string;
  /**
   * Echoed back on a refusal. React 19 resets an uncontrolled form when its
   * action returns, so without these a rejected "45 days before" snaps back to
   * the stored value and looks as though the typing never happened — the trap
   * the currency screen hit first.
   */
  submitted?: { direction: OffsetDirection; days: string; enabled: boolean };
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function readDirection(value: FormDataEntryValue | null): OffsetDirection {
  return value === "before" || value === "after" ? value : "on";
}

/**
 * Move a reminder, or switch it off.
 *
 * ⚠️ THIS IS NOT THE CURRENCY DEFAULT — IT CHANGES INVOICES THAT ALREADY EXIST.
 * The API recomputes every live invoice org-wide in the same transaction as the
 * edit (`reminders.service.ts` §updateStep), so a customer who moves the first
 * reminder has just moved it on their whole book, not merely on invoices they
 * raise from now on. The success line says so, because "saved" would let
 * someone believe they had changed a default and nothing more.
 */
export async function updateReminderStep(
  _prevState: ReminderStepActionState,
  formData: FormData,
): Promise<ReminderStepActionState> {
  const organisationId = String(formData.get("organisationId") ?? "");
  const stepId = String(formData.get("stepId") ?? "");
  const direction = readDirection(formData.get("direction"));
  const enabled = formData.get("enabled") === "on";

  /**
   * An empty box is not zero. `Number("")` is 0, which would silently move a
   * reminder onto the due date because somebody cleared the field before
   * typing — so the empty case is refused rather than coerced.
   */
  const rawDays = String(formData.get("days") ?? "").trim();
  const submitted = { direction, days: rawDays, enabled };

  if (direction !== "on" && rawDays === "") {
    return { stepId, submitted, error: "Enter how many days." };
  }
  const days = direction === "on" ? 0 : Number(rawDays);

  const invalid = validateOffset(direction, days);
  if (invalid) return { stepId, submitted, error: invalid };

  const offsetDays = toOffsetDays(direction, days);

  const accessToken = await getAccessToken();
  if (!accessToken) redirect("/sign-in");

  try {
    await apiFetch(
      `/organisations/${organisationId}/reminder-sequence/steps/${stepId}`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offsetDays, enabled }),
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    return {
      stepId,
      submitted,
      error:
        error instanceof ApiError
          ? (humanRefusal(error.status, "change-reminder-timing") ?? error.message)
          : "Something went wrong. Please try again.",
    };
  }

  /**
   * Both screens that read the schedule are now stale: this one shows the
   * timing, and the activity screen lists the scheduled rows the API has just
   * recomputed.
   */
  revalidatePath("/app/settings/reminders");
  revalidatePath("/app/reminders");

  return {
    stepId,
    success: enabled
      ? `Saved — ${describeOffset(offsetDays).toLowerCase()}. Invoices you are already chasing have been rescheduled too.`
      : "Saved — Eva will skip this stage. Invoices you are already chasing have been rescheduled too.",
  };
}
