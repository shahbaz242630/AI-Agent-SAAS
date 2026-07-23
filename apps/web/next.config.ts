import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

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
