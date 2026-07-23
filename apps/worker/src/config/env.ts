import { z } from "zod";

/** Environment variables for the worker (Trigger.dev task project). Validated — fail fast. */
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Trigger.dev project ref from the dashboard — required to deploy, not to typecheck. */
  TRIGGER_PROJECT_REF: z.string().optional(),
  /** Sentry DSN (Slice 0.4) — empty/unset disables Sentry; always disabled in tests. */
  SENTRY_DSN_WORKER: z.string().default(""),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
