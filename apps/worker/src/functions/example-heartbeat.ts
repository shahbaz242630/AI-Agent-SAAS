import { inngest } from "../inngest/client.js";

/**
 * Example durable function — proves the Inngest pipeline end-to-end in Phase 0
 * (BRD Phase 0 scope: "Inngest integration skeleton with one example durable
 * function"). Replaced by real reminder/send functions from Phase 1 onwards.
 */
export const exampleHeartbeat = inngest.createFunction(
  { id: "example-heartbeat", retries: 3 },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const beat = await step.run("beat", () => ({
      ok: true,
      at: new Date().toISOString(),
    }));
    return beat;
  },
);
