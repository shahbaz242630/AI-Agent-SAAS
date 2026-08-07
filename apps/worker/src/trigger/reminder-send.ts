import { schedules } from "@trigger.dev/sdk/v3";
import { loadEnv } from "@eva/configuration";
import { workerEnvSchema } from "../config/env.js";

/** POST /internal/reminders/send response — mirrors the API's SendRemindersResult. */
export interface SendRemindersResult {
  sent: number;
  failed: number;
  held: number;
  heldReasons: Record<string, number>;
  organisationsFailed: string[];
  /**
   * ⚠️ THE SCALE TRIPWIRE. Returned from the task, so Trigger.dev's own run
   * history plots it with no metrics stack to build. `maxDuration` is 300s
   * (trigger.config.ts) and the sweep is serial, so a `durationMs` climbing
   * towards it is the early warning that the send loop needs concurrency —
   * visible on a dashboard we already have, well before a customer notices.
   */
  organisationsProcessed: number;
  durationMs: number;
  /** Rows a previous run left stranded mid-send. Normally 0; anything else
   *  means a process died and is worth seeing in the run history. */
  recovered: number;
}

/**
 * The send sweep (Slice 1.7). A thin durable timer, like the reconcile task —
 * ALL business logic lives in the API (plan §7.2) and this only calls it.
 *
 * A non-2xx throws so Trigger.dev retries. A 200 carrying holds or per-org
 * failures does NOT throw: the API has already isolated, counted and logged
 * them, and a held reminder is an expected state (a dead mailbox, a rate
 * limit) rather than a task failure. Throwing would retry the whole sweep to
 * no purpose and bury the real signal in red task runs.
 */
export async function runReminderSend(): Promise<SendRemindersResult> {
  const env = loadEnv(workerEnvSchema);
  const baseUrl = env.API_BASE_URL.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/internal/reminders/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.INTERNAL_API_SECRET,
    },
    body: "{}",
  });
  if (!response.ok) {
    // Status only — never the response body or headers (the secret must not leak).
    throw new Error(`reminder send request failed with status ${response.status}`);
  }
  return (await response.json()) as SendRemindersResult;
}

/**
 * 08:07, 11:07 and 14:07 UTC — UK business hours, and deliberately off the
 * :00/:30 herd like the reconcile task.
 *
 * ⚠️ THREE RUNS A DAY IS THE RETRY MECHANISM, NOT AN ACCIDENT. Each row is
 * claimed before it sends and the read only picks up `ready`, so a repeat sweep
 * is a no-op for anything already sent — the later runs exist purely to flush
 * what was HELD earlier. A mailbox reconnected at 10am, or a Microsoft rate
 * limit at 08:07, then goes out the same working day instead of waiting for
 * tomorrow.
 *
 * ⚠️ MUST STAY AFTER `REMINDER_RECONCILE_CRON`, which is what makes rows
 * `ready`. Sending first would find nothing on its first pass of the day.
 * A test asserts the ordering, because a cron string is exactly the kind of
 * value someone tidies later without knowing why.
 */
export const REMINDER_SEND_CRON = "7 8,11,14 * * *";

export const reminderSend = schedules.task({
  id: "reminder-send",
  cron: REMINDER_SEND_CRON,
  run: runReminderSend,
});
