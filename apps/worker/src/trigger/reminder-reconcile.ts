import { schedules } from "@trigger.dev/sdk/v3";
import { loadEnv } from "@eva/configuration";
import { workerEnvSchema } from "../config/env.js";

/** POST /internal/reminders/reconcile response (plan §7.8) — mirrors the API's ReconcileResult. */
export interface ReconcileResult {
  processed: number;
  failed: string[];
}

/**
 * The daily reconcile call (Slice 1.5, plan §7.2 — thin durable timer; ALL
 * business logic lives in the API). Fires POST /internal/reminders/reconcile
 * and returns the summary as the task run output. A non-2xx throws so
 * Trigger.dev retries (maxAttempts 3, trigger.config.ts); a partial-failure
 * 200 does NOT throw — the API already isolated and logged those orgs.
 */
export async function runReminderReconcile(): Promise<ReconcileResult> {
  const env = loadEnv(workerEnvSchema);
  const baseUrl = env.API_BASE_URL.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/internal/reminders/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.INTERNAL_API_SECRET,
    },
    body: "{}",
  });
  if (!response.ok) {
    // Status only — never the response body or headers (the secret must not leak).
    throw new Error(`reminder reconcile request failed with status ${response.status}`);
  }
  return (await response.json()) as ReconcileResult;
}

export const reminderReconcile = schedules.task({
  id: "reminder-reconcile",
  // 06:17 UTC daily — before UK business hours, deliberately off the :00/:30 herd.
  cron: "17 6 * * *",
  run: runReminderReconcile,
});
