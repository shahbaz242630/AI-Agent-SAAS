import { loadEnv, loadRootEnvFile } from "@eva/configuration";
import { initSentry } from "./common/monitoring/sentry.js";
import { apiEnvSchema } from "./config/env.js";

/**
 * Sentry must initialise BEFORE the NestJS/Express modules are evaluated so
 * tracing instrumentation hooks them (BRD 14). Imported first from main.ts —
 * keep this module free of any Nest imports.
 */

// Local development only, and only for variables not already set — see
// loadRootEnvFile. This is the FIRST thing that runs in the process, because
// everything below reads process.env.
loadRootEnvFile();

initSentry(loadEnv(apiEnvSchema));
