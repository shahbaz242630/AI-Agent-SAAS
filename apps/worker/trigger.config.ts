import { defineConfig } from "@trigger.dev/sdk/v3";
import { loadEnv } from "@eva/configuration";
import { workerEnvSchema } from "./src/config/env.js";
import { initSentry } from "./src/config/sentry.js";

// Error reporting for task runs (BRD 14) — no-op without a DSN and in tests.
initSentry(loadEnv(workerEnvSchema));

/**
 * Trigger.dev v4 project config (BRD 9.3 — locked 2026-07-22).
 * Tasks execute on Trigger.dev Cloud; this package is their code home.
 * The project ref comes from the Trigger.dev dashboard (founder creates the
 * account); set TRIGGER_PROJECT_REF in env, never commit the real ref's keys.
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  dirs: ["src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
    },
  },
});
