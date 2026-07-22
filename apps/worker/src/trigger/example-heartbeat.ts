import { schedules, wait } from "@trigger.dev/sdk/v3";

/**
 * Example durable task — proves the Trigger.dev pipeline end-to-end in Phase 0
 * (BRD Phase 0 scope: background-jobs skeleton with one example durable
 * function). Scheduled every 15 minutes; the 5-second wait demonstrates
 * durable waits — checkpointed, free, and consuming no concurrency, which is
 * exactly what the multi-day invoice-chase flows of Phase 1+ rely on.
 * Replaced by real reminder/send tasks from Phase 1 onwards.
 */
export const exampleHeartbeat = schedules.task({
  id: "example-heartbeat",
  cron: "*/15 * * * *",
  run: async () => {
    await wait.for({ seconds: 5 });
    return {
      ok: true,
      at: new Date().toISOString(),
    };
  },
});
