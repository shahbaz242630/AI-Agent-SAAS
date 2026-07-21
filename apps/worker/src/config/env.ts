import { z } from "zod";

/** Environment variables required by the worker process. Validated at boot — fail fast. */
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
