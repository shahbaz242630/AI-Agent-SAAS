import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { z } from "zod";

/** How far up from the working directory to look for the repo-root `.env`. */
const MAX_PARENT_DIRECTORIES = 6;

/**
 * Load the repo-root `.env` into `process.env` for LOCAL DEVELOPMENT.
 *
 * `AGENTS.md` has always told you to copy `.env.example` to `.env` and run
 * `pnpm dev` — but until 2026-07-31 nothing in the codebase read that file. It
 * only ever worked in deploy, where Railway injects real environment
 * variables. Locally the API crash-looped on boot with "Invalid environment
 * configuration", and every run needed the variables injected by hand.
 *
 * Two deliberate properties:
 *
 * - **Never in production.** Deploy platforms own the environment there, and
 *   a stray file must not be able to influence it.
 * - **Real environment variables always win.** Values already present are left
 *   alone, so `FOO=bar pnpm dev` still beats the file and CI is unaffected.
 *
 * Walks up from the working directory because apps run from their own
 * package folder (`apps/api`, `apps/web`) while the `.env` lives at the root.
 *
 * @returns the path loaded, or null when nothing was loaded
 */
export function loadRootEnvFile(startDirectory: string = process.cwd()): string | null {
  if (process.env.NODE_ENV === "production") return null;
  let directory = resolve(startDirectory);
  for (let depth = 0; depth < MAX_PARENT_DIRECTORIES; depth += 1) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      const parsed = parseEnv(readFileSync(candidate, "utf8")) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined && typeof value === "string") {
          process.env[key] = value;
        }
      }
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Validate process configuration at boot and fail fast on misconfiguration.
 * Every app defines its own zod env schema; this is the single loader so
 * validation behaviour (error shape, source override for tests) is consistent.
 *
 * @param schema  zod schema describing the app's environment
 * @param source  env source — defaults to process.env; tests pass plain objects
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data as z.infer<S>;
}
