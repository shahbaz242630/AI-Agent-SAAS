import { z } from "zod";

/** Environment variables required by the API process. Validated at boot — fail fast. */
export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Supabase Auth (Slice 0.3): access tokens are verified against the project
  // JWKS at ${SUPABASE_URL}/auth/v1/.well-known/jwks.json.
  SUPABASE_URL: z.string().url(),
  // Public anon key — present for parity with the web app; may be empty in dev.
  SUPABASE_ANON_KEY: z.string().default(""),
  // Runtime database connection as the eva_app role (NOBYPASSRLS) — RLS applies.
  APP_DATABASE_URL: z.string().url().default("postgresql://eva_app:eva_app@localhost:5432/eva"),
  // Sentry DSN (Slice 0.4) — empty disables Sentry; always disabled in tests.
  SENTRY_DSN_API: z.string().default(""),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
