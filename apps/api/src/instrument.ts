import { loadEnv } from "@eva/configuration";
import { initSentry } from "./common/monitoring/sentry.js";
import { apiEnvSchema } from "./config/env.js";

/**
 * Sentry must initialise BEFORE the NestJS/Express modules are evaluated so
 * tracing instrumentation hooks them (BRD 14). Imported first from main.ts —
 * keep this module free of any Nest imports.
 */
initSentry(loadEnv(apiEnvSchema));
