import { loadRootEnvFile } from "@eva/configuration";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// Next.js reads env files from its OWN directory, never the repo root, so the
// root .env that AGENTS.md tells you to create was invisible here — the dev
// server started and then threw "NEXT_PUBLIC_SUPABASE_URL is not set" on every
// request. Loading it in next.config puts the values in process.env before
// Next inlines any NEXT_PUBLIC_* variable, which is why this cannot move
// later. Local development only; see loadRootEnvFile.
loadRootEnvFile();

const nextConfig: NextConfig = {
  // The founder's local .env stores the web DSN as SENTRY_DSN_WEB, but the
  // browser bundle can only see NEXT_PUBLIC_* variables — bridge it here so
  // instrumentation-client.ts can read it (BRD 14).
  env: {
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN_WEB ?? "",
  },
};

// Source maps upload only when CI provides SENTRY_AUTH_TOKEN (plus
// SENTRY_ORG / SENTRY_PROJECT, all read from the environment by the plugin).
// Without a token the plugin warns and skips the upload, so local builds and
// PRs never fail.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
});
