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
  // Shared secret for internal service-to-service endpoints (Slice 1.5, plan
  // §7.8: the Trigger.dev reconcile sweep calls POST /internal/reminders/
  // reconcile). Required, minimum 32 chars; compared in constant time.
  INTERNAL_API_SECRET: z.string().min(32),
  // Slice 1.6 — Outlook connection. Token encryption at rest (ruling 2):
  // 32 bytes, base64 (generate: openssl rand -base64 32).
  TOKEN_ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded",
  }),
  // HS256 signing secret for the OAuth state JWT (ruling 4).
  OAUTH_STATE_SECRET: z.string().min(32),
  // Multi-tenant Entra app registration (plan §10); tenant "common" = any org directory.
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_TENANT: z.string().min(1).default("common"),
  MICROSOFT_OAUTH_REDIRECT_URI: z.string().url(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
